/**
 * T.C. ELDİVAN BELEDİYE BAŞKANLIĞI - 7/24 BAĞIMSIZ BULUT & SUNUCU MOTORU (server.js)
 * Bilgisayarınız kapalıyken bile Render.com, Koyeb, Railway veya Belediye Sunucusu üzerinde
 * 7/24 kesintisiz çalışır ve tüm verileri AES-256-GCM şifreli olarak GitHub Bulutunda tutar.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');

const serverPort = process.env.PORT || 3500;
const activeSessions = new Map();
const DEFAULT_CLOUD_SECRET = process.env.ENCRYPTION_KEY || 'ELDIVAN-BLD-2026-GIZLI-ANAHTAR';

// AES-256-GCM Encrypted Cloud Bootstrap Vault (Zero plaintext token in source code)
const CLOUD_BOOTSTRAP = {
  gistId: 'd88d80597b1931ae5555c062807547c2',
  repoName: 'Hilmi024/eldivan-belediye-portali',
  tokenVault: {
    iv: '2IYJYn6sWWUvdUeF',
    tag: 'QExTKLy9gZp+kWbVDaoa6Q==',
    cipher: 'hi2x0KpXPiInX/5Rw8ChZ6Z2yXO/2we2O2dOzvQgOSSBL/J0WW8sxA=='
  }
};

function unlockBootstrapToken(secretPassphrase) {
  try {
    const secret = (secretPassphrase && secretPassphrase.trim()) ? secretPassphrase.trim() : DEFAULT_CLOUD_SECRET;
    const key = crypto.createHash('sha256').update(secret, 'utf8').digest();
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(CLOUD_BOOTSTRAP.tokenVault.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(CLOUD_BOOTSTRAP.tokenVault.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(CLOUD_BOOTSTRAP.tokenVault.cipher, 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch (e) {
    return '';
  }
}

const localDataPath = path.join(__dirname, 'belediye_v3_server_data.json');
const cloudMirrorPath = path.join(__dirname, 'belediye_v3_data_cloud.json');
const dbPath = path.join(__dirname, 'events_db.json');

let isCloudSyncing = false;

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const localIpAddress = getLocalIp();

function encryptCloudPayload(plainObj, secretPassphrase) {
  const secret = (secretPassphrase && secretPassphrase.trim()) ? secretPassphrase.trim() : DEFAULT_CLOUD_SECRET;
  const key = crypto.createHash('sha256').update(secret, 'utf8').digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(plainObj);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return JSON.stringify({
    encrypted: true,
    algorithm: 'AES-256-GCM',
    notice: 'T.C. Eldivan Belediyesi Kriptolu Bulut Veritabani - Yetkisiz erisime kapalidir.',
    iv: iv.toString('base64'),
    tag: authTag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
    updatedAt: new Date().toISOString()
  }, null, 2);
}

function decryptCloudPayload(rawContent, secretPassphrase) {
  const parsed = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;
  if (!parsed || !parsed.encrypted) return parsed;
  const secret = (secretPassphrase && secretPassphrase.trim()) ? secretPassphrase.trim() : DEFAULT_CLOUD_SECRET;
  const key = crypto.createHash('sha256').update(secret, 'utf8').digest();
  const iv = Buffer.from(parsed.iv, 'base64');
  const authTag = Buffer.from(parsed.tag, 'base64');
  const encryptedText = Buffer.from(parsed.ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString('utf8');
  return JSON.parse(decrypted);
}

function sanitizeDataForUser(rawData, sessionUser) {
  const copy = JSON.parse(JSON.stringify(rawData));
  const role = sessionUser ? sessionUser.role : '';
  const isAdmin = role === 'admin';
  const isExecutive = ['admin', 'baskan', 'sekreterya'].includes(role);

  if (!isAdmin && Array.isArray(copy.users)) {
    copy.users = copy.users.map(u => {
      if (sessionUser && u.username.toLowerCase() === sessionUser.username.toLowerCase()) return u;
      return {
        username: u.username,
        name: u.name,
        role: u.role,
        defaultPersonnel: u.defaultPersonnel,
        activePersonnel: u.activePersonnel
      };
    });
  }

  if (!isExecutive && copy.settings && copy.settings.cloudConfig) {
    copy.settings.cloudConfig = {
      enabled: copy.settings.cloudConfig.enabled,
      provider: copy.settings.cloudConfig.provider,
      lastCloudSync: copy.settings.cloudConfig.lastCloudSync,
      lastCloudStatus: copy.settings.cloudConfig.lastCloudStatus
    };
  }
  return copy;
}

function getDefaultV3Data() {
  const defaultToken = process.env.GITHUB_TOKEN || unlockBootstrapToken(DEFAULT_CLOUD_SECRET);
  const defaultGist = process.env.GIST_ID || CLOUD_BOOTSTRAP.gistId;
  return {
    users: [
      { username: 'baskan', password: '123', role: 'baskan', name: 'Eldivan Belediye Başkanı', defaultPersonnel: 'Belediye Başkanı' },
      { username: 'sekreter', password: '123', role: 'sekreterya', name: 'Özel Kalem & Sekreterya', defaultPersonnel: 'Özel Kalem Sorumlusu' },
      { username: 'yaziisleri', password: '123', role: 'yazi_isleri', name: 'Yazı İşleri Müdürlüğü', defaultPersonnel: 'Yazı İşleri Müdürü' },
      { username: 'fenisleri', password: '123', role: 'fen_isleri', name: 'Fen İşleri Müdürlüğü', defaultPersonnel: 'Fen İşleri Müdürü' },
      { username: 'muhasebe', password: '123', role: 'muhasebe', name: 'Mali Hizmetler / Muhasebe', defaultPersonnel: 'Mali Hizmetler Müdürü' },
      { username: 'zabita', password: '123', role: 'zabita', name: 'Zabıta Amirliği', defaultPersonnel: 'Zabıta Amiri' },
      { username: 'imar', password: '123', role: 'imar', name: 'İmar ve Şehircilik Müdürlüğü', defaultPersonnel: 'İmar Müdürü' },
      { username: 'parkbahceler', password: '123', role: 'park_bahceler', name: 'Park Bahçeler & Temizlik İşleri', defaultPersonnel: 'Temizlik & Park Sorumlusu' },
      { username: 'kultur', password: '123', role: 'kultur', name: 'Kültür ve Sosyal İşler', defaultPersonnel: 'Kültür İşleri Sorumlusu' },
      { username: 'admin', password: '123', role: 'admin', name: 'Sistem Yöneticisi (Admin)', defaultPersonnel: 'Bilgi İşlem Yöneticisi' }
    ],
    settings: {
      autostart: true,
      minimizeToTray: true,
      notificationTime: '09:00',
      serverPort: Number(serverPort),
      cloudConfig: {
        enabled: true,
        provider: 'github-gist',
        githubToken: defaultToken,
        gistId: defaultGist,
        githubRepo: process.env.GITHUB_REPO || CLOUD_BOOTSTRAP.repoName,
        customUrl: process.env.CLOUD_URL || '',
        encryptionKey: DEFAULT_CLOUD_SECRET,
        autoGitPush: false,
        lastCloudSync: new Date().toLocaleString('tr-TR'),
        lastCloudStatus: 'synced',
        lastCloudError: ''
      }
    },
    mayorStatus: 'kabul-acik',
    currentGuest: { name: 'Makam Boş', institution: 'Herhangi Bir Kabul Yok', topic: '--', startTime: '--:--', elapsedMinutes: 0 },
    waitingRoom: [],
    mayorSchedule: [],
    documents: [],
    appointments: [],
    archivedAppointments: [],
    archivedDocuments: [],
    unitTasks: [],
    chatMessages: [],
    auditLogs: []
  };
}

function addAuditLog(data, user, userRole, action, details) {
  if (!data.auditLogs) data.auditLogs = [];
  data.auditLogs.unshift({
    id: 'log_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    timestamp: new Date().toLocaleString('tr-TR'),
    user: user || 'Sistem',
    userRole: userRole || 'Birim',
    action,
    details
  });
  if (data.auditLogs.length > 500) data.auditLogs = data.auditLogs.slice(0, 500);
}

function ensureCloudCredentials(data) {
  if (!data.settings) data.settings = {};
  if (!data.settings.cloudConfig) data.settings.cloudConfig = {};
  const cfg = data.settings.cloudConfig;
  if (!cfg.githubToken) cfg.githubToken = process.env.GITHUB_TOKEN || unlockBootstrapToken(cfg.encryptionKey || DEFAULT_CLOUD_SECRET);
  if (!cfg.gistId) cfg.gistId = process.env.GIST_ID || CLOUD_BOOTSTRAP.gistId;
  if (!cfg.encryptionKey) cfg.encryptionKey = DEFAULT_CLOUD_SECRET;
  if (cfg.enabled === undefined) cfg.enabled = true;
  return data;
}

function loadV3Data() {
  try {
    if (fs.existsSync(localDataPath)) {
      return ensureCloudCredentials(JSON.parse(fs.readFileSync(localDataPath, 'utf8')));
    }
    if (fs.existsSync(cloudMirrorPath)) {
      const decrypted = decryptCloudPayload(fs.readFileSync(cloudMirrorPath, 'utf8'), DEFAULT_CLOUD_SECRET);
      if (decrypted && decrypted.users) {
        return ensureCloudCredentials(decrypted);
      }
    }
  } catch (e) {
    console.warn('Initial data load fallback:', e.message);
  }
  const def = getDefaultV3Data();
  saveV3Data(def, true);
  return def;
}

function saveV3Data(data, skipCloudPush = false) {
  try {
    ensureCloudCredentials(data);
    if (!skipCloudPush) data.lastUpdatedTimestamp = Date.now();
    fs.writeFileSync(localDataPath, JSON.stringify(data, null, 2), 'utf8');

    const cleanForCloud = JSON.parse(JSON.stringify(data));
    const secretKey = (data.settings && data.settings.cloudConfig && data.settings.cloudConfig.encryptionKey) || DEFAULT_CLOUD_SECRET;
    if (cleanForCloud.settings && cleanForCloud.settings.cloudConfig) {
      cleanForCloud.settings.cloudConfig.githubToken = '';
      cleanForCloud.settings.cloudConfig.encryptionKey = '';
    }
    fs.writeFileSync(cloudMirrorPath, encryptCloudPayload(cleanForCloud, secretKey), 'utf8');

    if (!skipCloudPush && data.settings && data.settings.cloudConfig && data.settings.cloudConfig.enabled) {
      pushToCloudDatabase(data).catch(() => {});
    }
  } catch (e) {
    console.error('Save error:', e.message);
  }
}

function httpsRequestJson(urlStr, method = 'GET', headers = {}, bodyObj = null) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(urlStr);
      const isHttps = parsed.protocol === 'https:';
      const client = isHttps ? https : http;
      const bodyData = bodyObj ? (typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj)) : null;
      const reqHeaders = {
        'User-Agent': 'Eldivan-Belediye-Cloud-Server-v4',
        'Accept': 'application/vnd.github+json, application/json',
        ...headers
      };
      if (bodyData) {
        reqHeaders['Content-Type'] = 'application/json; charset=utf-8';
        reqHeaders['Content-Length'] = Buffer.byteLength(bodyData, 'utf8');
      }
      const req = client.request({
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: reqHeaders
      }, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try {
            const json = raw ? JSON.parse(raw) : {};
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: json, error: json.message });
          } catch (e) {
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: raw });
          }
        });
      });
      req.on('error', err => reject(err));
      if (bodyData) req.write(bodyData);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function pushToCloudDatabase(data, forceRun = false) {
  if (isCloudSyncing && !forceRun) return { success: false };
  ensureCloudCredentials(data);
  const cfg = (data.settings && data.settings.cloudConfig) ? data.settings.cloudConfig : null;
  if (!cfg || (!cfg.enabled && !forceRun)) return { success: false };

  isCloudSyncing = true;
  try {
    const cloudPayload = JSON.parse(JSON.stringify(data));
    if (cloudPayload.settings && cloudPayload.settings.cloudConfig) {
      cloudPayload.settings.cloudConfig.githubToken = '';
      cloudPayload.settings.cloudConfig.encryptionKey = '';
    }
    const contentString = encryptCloudPayload(cloudPayload, cfg.encryptionKey || DEFAULT_CLOUD_SECRET);

    if (cfg.provider === 'github-gist') {
      if (!cfg.githubToken) throw new Error('GitHub Token eksik');
      const authHeaders = { 'Authorization': `Bearer ${cfg.githubToken.trim()}` };
      if (!cfg.gistId || !cfg.gistId.trim()) {
        const createRes = await httpsRequestJson('https://api.github.com/gists', 'POST', authHeaders, {
          description: 'T.C. Eldivan Belediye Başkanlığı - AES-256 Kriptolu Bulut Veritabanı',
          public: false,
          files: { 'belediye_v3_data.json': { content: contentString } }
        });
        if (!createRes.ok) throw new Error(createRes.error || 'Gist oluşturulamadı');
        cfg.gistId = createRes.data.id;
      } else {
        const updateRes = await httpsRequestJson(`https://api.github.com/gists/${cfg.gistId.trim()}`, 'PATCH', authHeaders, {
          files: { 'belediye_v3_data.json': { content: contentString } }
        });
        if (!updateRes.ok) throw new Error(updateRes.error || 'Gist güncellenemedi');
      }
    }
    cfg.lastCloudSync = new Date().toLocaleString('tr-TR');
    cfg.lastCloudStatus = 'synced';
    cfg.lastCloudError = '';
    saveV3Data(data, true);
    isCloudSyncing = false;
    return { success: true, gistId: cfg.gistId };
  } catch (err) {
    cfg.lastCloudStatus = 'error';
    cfg.lastCloudError = err.message;
    saveV3Data(data, true);
    isCloudSyncing = false;
    return { success: false, message: err.message };
  }
}

async function pullFromCloudDatabase(forceOverwrite = false) {
  if (isCloudSyncing) return { success: false };
  const localData = loadV3Data();
  const cfg = (localData.settings && localData.settings.cloudConfig) ? localData.settings.cloudConfig : null;
  if (!cfg || (!cfg.enabled && !forceOverwrite)) return { success: false };

  isCloudSyncing = true;
  try {
    let remoteData = null;
    const secretKey = cfg.encryptionKey || DEFAULT_CLOUD_SECRET;
    if (cfg.provider === 'github-gist' && cfg.gistId) {
      const headers = cfg.githubToken ? { 'Authorization': `Bearer ${cfg.githubToken.trim()}` } : {};
      const res = await httpsRequestJson(`https://api.github.com/gists/${cfg.gistId.trim()}`, 'GET', headers);
      if (res.ok && res.data.files) {
        const fileObj = res.data.files['belediye_v3_data.json'] || Object.values(res.data.files)[0];
        if (fileObj && fileObj.content) remoteData = decryptCloudPayload(fileObj.content, secretKey);
      }
    }
    if (remoteData && remoteData.users) {
      if (forceOverwrite || (remoteData.lastUpdatedTimestamp || 0) > (localData.lastUpdatedTimestamp || 0)) {
        remoteData.settings = remoteData.settings || {};
        remoteData.settings.cloudConfig = { ...cfg, lastCloudSync: new Date().toLocaleString('tr-TR'), lastCloudStatus: 'synced', lastCloudError: '' };
        saveV3Data(remoteData, true);
      }
    }
    isCloudSyncing = false;
    return { success: true };
  } catch (err) {
    isCloudSyncing = false;
    return { success: false, message: err.message };
  }
}

// Start 24/7 HTTP Cloud Server
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const sessionUser = activeSessions.get(req.headers['x-auth-token']);

  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: '7/24 Aktif', timestamp: Date.now() }));
    return;
  }

  if (pathname === '/api/data') {
    if (!sessionUser) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Yetkisiz erişim! Lütfen giriş yapınız.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(sanitizeDataForUser(loadV3Data(), sessionUser)));
    return;
  }

  if (pathname === '/api/events-db') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(fs.readFileSync(dbPath, 'utf8'));
    return;
  }

  if (pathname === '/api/server-info') {
    const hostUrl = req.headers.host ? `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}` : `http://${localIpAddress}:${serverPort}`;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ip: localIpAddress, port: serverPort, url: hostUrl }));
    return;
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { username, password, personnelFullName } = JSON.parse(body);
        const data = loadV3Data();
        const found = data.users.find(u => u.username.toLowerCase() === (username || '').toLowerCase() && u.password === password);
        if (found) {
          if (personnelFullName && personnelFullName.trim()) found.activePersonnel = personnelFullName.trim();
          const authToken = crypto.randomBytes(32).toString('hex');
          activeSessions.set(authToken, { username: found.username, role: found.role, name: found.name, createdAt: Date.now() });
          addAuditLog(data, found.activePersonnel || found.username, found.name, 'Kullanıcı Girişi', `${found.activePersonnel || found.name} oturum açtı.`);
          saveV3Data(data);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, user: found, authToken }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Hatalı kullanıcı adı veya şifre!' }));
        }
      } catch (e) { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (pathname === '/api/action' && req.method === 'POST') {
    if (!sessionUser) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: 'Yetkisiz erişim!' }));
      return;
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const data = loadV3Data();
        const userStr = payload.user || 'Sistem';

        if (payload.action === 'add-mayor') {
          payload.item.id = 'ms_' + Date.now();
          data.mayorSchedule.unshift(payload.item);
          addAuditLog(data, userStr, 'Başkanlık/Sekreterya', 'Program Eklendi', `Başkan Programı: ${payload.item.title}`);
        } else if (payload.action === 'delete-mayor') {
          data.mayorSchedule = data.mayorSchedule.filter(x => x.id !== payload.id);
          addAuditLog(data, userStr, 'Yönetici', 'Program Silindi', `Program ID: ${payload.id}`);
        } else if (payload.action === 'add-doc') {
          payload.doc.id = 'doc_' + Date.now();
          if (!payload.doc.status) payload.doc.status = 'İmza Bekliyor';
          if (!payload.doc.signType) payload.doc.signType = 'islak';
          data.documents.unshift(payload.doc);
          addAuditLog(data, userStr, payload.doc.assignedUnitName, 'İmza / Evrak Girişi', `[${payload.doc.signType === 'e-imza' ? 'E-İmza' : 'Islak İmza'}] ${payload.doc.title}`);
        } else if (payload.action === 'update-doc-status') {
          const idx = data.documents.findIndex(x => x.id === payload.id);
          if (idx !== -1) {
            const doc = data.documents.splice(idx, 1)[0];
            if (!data.archivedDocuments) data.archivedDocuments = [];
            data.archivedDocuments.unshift({ ...doc, status: payload.status, archivedDate: new Date().toLocaleString('tr-TR'), archivedBy: userStr });
            addAuditLog(data, userStr, doc.assignedUnitName || 'Makam', `İmza Durumu: ${payload.status}`, doc.title);
          }
        } else if (payload.action === 'delete-doc') {
          data.documents = data.documents.filter(x => x.id !== payload.id);
        } else if (payload.action === 'add-appnt') {
          payload.appnt.id = 'appnt_' + Date.now();
          data.appointments.unshift(payload.appnt);
          addAuditLog(data, userStr, payload.appnt.institution || 'Özel Kalem', 'Randevu Talebi', `${payload.appnt.visitorName} - ${payload.appnt.topic}`);
        } else if (payload.action === 'update-appnt-status') {
          const idx = data.appointments.findIndex(x => x.id === payload.id);
          if (idx !== -1) {
            const appnt = data.appointments[idx];
            appnt.status = payload.status;
            if (payload.date) appnt.date = payload.date;
            if (payload.time) appnt.time = payload.time;
            if (payload.notes) appnt.notes = payload.notes;
            if (payload.status === 'Tamamlandı' || payload.status === 'Reddedildi') {
              data.appointments.splice(idx, 1);
              if (!data.archivedAppointments) data.archivedAppointments = [];
              data.archivedAppointments.unshift({ ...appnt, archivedDate: new Date().toLocaleString('tr-TR'), archivedBy: userStr });
            }
          }
        } else if (payload.action === 'delete-appnt') {
          data.appointments = data.appointments.filter(x => x.id !== payload.id);
        } else if (payload.action === 'edit-appnt') {
          const idx = data.appointments.findIndex(x => x.id === payload.id);
          if (idx !== -1) {
            data.appointments[idx] = { ...data.appointments[idx], ...payload.appnt, isEdited: true, lastUpdatedBy: userStr };
          }
        } else if (payload.action === 'add-waiting-room') {
          if (!data.waitingRoom) data.waitingRoom = [];
          payload.item.id = 'wr_' + Date.now();
          data.waitingRoom.push(payload.item);
          data.waitingRoom.sort((a, b) => (a.priority || 3) - (b.priority || 3));
        } else if (payload.action === 'admit-waiting-guest') {
          const idx = (data.waitingRoom || []).findIndex(x => x.id === payload.id);
          if (idx !== -1) {
            const g = data.waitingRoom.splice(idx, 1)[0];
            data.currentGuest = { name: g.visitorName, institution: g.institution || g.type, topic: g.topic, startTime: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) };
          }
        } else if (payload.action === 'convert-waiting-to-appnt') {
          const idx = (data.waitingRoom || []).findIndex(x => x.id === payload.id);
          if (idx !== -1) {
            const w = data.waitingRoom.splice(idx, 1)[0];
            data.appointments.unshift({ id: 'appnt_' + Date.now(), visitorName: w.visitorName, institution: w.institution, visitorCategory: w.type, date: payload.date, time: payload.time, topic: w.topic, status: 'Onaylandı' });
          }
        } else if (payload.action === 'update-waiting-priority') {
          const idx = (data.waitingRoom || []).findIndex(x => x.id === payload.id);
          if (idx !== -1) {
            if (payload.priority !== undefined) {
              data.waitingRoom[idx].priority = Number(payload.priority);
              data.waitingRoom.sort((a, b) => (a.priority || 3) - (b.priority || 3));
            } else if (payload.direction === 'up' && idx > 0) {
              const t = data.waitingRoom[idx - 1]; data.waitingRoom[idx - 1] = data.waitingRoom[idx]; data.waitingRoom[idx] = t;
            } else if (payload.direction === 'down' && idx < data.waitingRoom.length - 1) {
              const t = data.waitingRoom[idx + 1]; data.waitingRoom[idx + 1] = data.waitingRoom[idx]; data.waitingRoom[idx] = t;
            }
          }
        } else if (payload.action === 'delete-waiting-room') {
          data.waitingRoom = (data.waitingRoom || []).filter(x => x.id !== payload.id);
        } else if (payload.action === 'complete-guest-take-next') {
          if (data.waitingRoom && data.waitingRoom.length > 0) {
            const next = data.waitingRoom.shift();
            data.currentGuest = { name: next.visitorName, institution: next.institution || 'Ziyaretçi', topic: next.topic || 'Genel Görüşme', startTime: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) };
          } else {
            data.currentGuest = { name: 'Makam Boş', institution: 'Bekleyen Yok', topic: '--', startTime: '--:--' };
          }
        } else if (payload.action === 'update-mayor-status') {
          data.mayorStatus = payload.status;
        } else if (payload.action === 'ring-bell') {
          data.lastBellRung = Date.now();
        } else if (payload.action === 'clear-room') {
          data.currentGuest = { name: 'Makam Boş', institution: 'Kabul Yok', topic: '--', startTime: '--:--' };
        } else if (payload.action === 'add-unit-task') {
          payload.task.id = 'ut_' + Date.now();
          data.unitTasks.unshift(payload.task);
        } else if (payload.action === 'respond-unit-task') {
          const idx = data.unitTasks.findIndex(x => x.id === payload.id);
          if (idx !== -1) {
            data.unitTasks[idx].status = payload.status;
            if (payload.unitNote) data.unitTasks[idx].unitNote = payload.unitNote;
            if (payload.rejectionReason) data.unitTasks[idx].rejectionReason = payload.rejectionReason;
            if (payload.revisedDate) data.unitTasks[idx].date = payload.revisedDate;
          }
        } else if (payload.action === 'edit-unit-task') {
          const idx = data.unitTasks.findIndex(x => x.id === payload.id);
          if (idx !== -1) {
            if (payload.title) data.unitTasks[idx].title = payload.title;
            if (payload.date) data.unitTasks[idx].date = payload.date;
            if (payload.notes) data.unitTasks[idx].notes = payload.notes;
          }
        } else if (payload.action === 'delete-unit-task') {
          data.unitTasks = data.unitTasks.filter(x => x.id !== payload.id);
        } else if (payload.action === 'send-chat-message') {
          if (!data.chatMessages) data.chatMessages = [];
          data.chatMessages.push({ id: 'msg_' + Date.now(), channel: payload.channel || 'genel', sender: userStr, senderName: payload.senderName || userStr, senderRole: payload.senderRole, text: payload.text, timestamp: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) });
        } else if (payload.action === 'change-user-credentials') {
          const u = data.users.find(x => x.username.toLowerCase() === payload.targetUsername.toLowerCase());
          if (u) { u.username = payload.newUsername.trim(); u.password = payload.newPassword; u.mustChangePassword = false; }
        } else if (payload.action === 'admin-save-user') {
          const idx = data.users.findIndex(u => u.username.toLowerCase() === (payload.userObj.originalUsername || payload.userObj.username).toLowerCase());
          if (idx !== -1) { data.users[idx] = { ...data.users[idx], ...payload.userObj }; delete data.users[idx].originalUsername; }
          else { data.users.push(payload.userObj); }
        } else if (payload.action === 'admin-delete-user') {
          data.users = data.users.filter(u => u.username.toLowerCase() !== payload.targetUsername.toLowerCase());
        }

        saveV3Data(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: sanitizeDataForUser(data, sessionUser) }));
      } catch (e) { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (pathname === '/api/cloud-sync' && req.method === 'POST') {
    if (!sessionUser) { res.writeHead(401); res.end(); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      const payload = JSON.parse(body);
      const data = loadV3Data();
      if (payload.subAction === 'save-config') {
        data.settings.cloudConfig = { ...data.settings.cloudConfig, ...payload.cloudConfig };
        saveV3Data(data, true);
        if (data.settings.cloudConfig.enabled) await pushToCloudDatabase(data, true);
      } else if (payload.subAction === 'push-now') {
        await pushToCloudDatabase(data, true);
      } else if (payload.subAction === 'pull-now') {
        await pullFromCloudDatabase(true);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: sanitizeDataForUser(loadV3Data(), sessionUser) }));
    });
    return;
  }

  const allowedStaticFiles = ['/', '/index.html', '/styles.css', '/renderer.js', '/icon.png', '/events_db.json'];
  if (!allowedStaticFiles.includes(pathname)) {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>403 - Gizli Alan (Yetkisiz Erişim Engellendi)</h1>');
    return;
  }

  const filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(content);
  });
});

server.listen(serverPort, '0.0.0.0', () => {
  console.log(`Eldivan Belediyesi 7/24 Bulut Sunucusu aktif: http://0.0.0.0:${serverPort}`);
  pullFromCloudDatabase(true).catch(() => {});
  setInterval(() => pullFromCloudDatabase(false).catch(() => {}), 8000);
});
