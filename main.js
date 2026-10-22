const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { exec } = require('child_process');
const os = require('os');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let serverPort = 3500;
let localIpAddress = '127.0.0.1';
let isCloudSyncing = false;

// Active authenticated sessions: token -> { username, role, name, createdAt }
const activeSessions = new Map();
const DEFAULT_CLOUD_SECRET = 'ELDIVAN-BLD-2026-GIZLI-ANAHTAR';

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
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(CLOUD_BOOTSTRAP.tokenVault.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(CLOUD_BOOTSTRAP.tokenVault.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(CLOUD_BOOTSTRAP.tokenVault.cipher, 'base64')), decipher.final()]).toString('utf8');
  } catch (e) {
    return '';
  }
}

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
  if (!parsed || !parsed.encrypted) {
    return parsed; // Backward-compatible if not yet encrypted
  }
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

  // Only Admin can view user password list & cloud tokens
  if (!isAdmin && Array.isArray(copy.users)) {
    copy.users = copy.users.map(u => {
      if (sessionUser && u.username.toLowerCase() === sessionUser.username.toLowerCase()) {
        return u;
      }
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

const userDataPath = path.join(app.getPath('userData'), 'belediye_v3_data.json');
const cloudMirrorPath = path.join(__dirname, 'belediye_v3_data_cloud.json');
const dbPath = path.join(__dirname, 'events_db.json');

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  let candidate = null;
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (!iface.address.startsWith('169.254.')) {
          if (iface.address.startsWith('192.168.') || iface.address.startsWith('10.') || iface.address.startsWith('172.')) {
            if (!name.includes('*') && !name.toLowerCase().includes('virtual') && !name.toLowerCase().includes('veth')) {
              return iface.address;
            }
            if (!candidate) candidate = iface.address;
          } else if (!candidate) {
            candidate = iface.address;
          }
        }
      }
    }
  }
  return candidate || '127.0.0.1';
}

localIpAddress = getLocalIp();

function getDefaultV3Data() {
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
    settings: { autostart: true, minimizeToTray: true, notificationTime: '09:00', serverPort: 3500 },
    mayorStatus: 'kabul-acik',
    currentGuest: {
      name: 'Ahmet Yılmaz',
      institution: 'Çiftçi Temsilcisi (Çay Mahallesi)',
      topic: 'Tarımsal Sulama Kanalı & Menfez Genişletme Talebi',
      startTime: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
      elapsedMinutes: 14
    },
    waitingRoom: [
      { id: 'wr_1', visitorName: 'Çankırı İl Özel İdaresi Heyeti', institution: 'İl Özel İdaresi / Protokol', type: 'Kurum / Protokol', priority: 1, arrivalTime: '14:15', topic: 'Yol & Menfez Protokolü', status: 'Bekliyor' },
      { id: 'wr_2', visitorName: 'Mehmet Demir', institution: 'Vatandaş - Kirazlık Mah.', type: 'Randevusuz', priority: 3, arrivalTime: '14:25', topic: 'Su Kesintisi ve Abonelik Talebi', status: 'Bekliyor' },
      { id: 'wr_3', visitorName: 'Hasan Kaya (Zabıta Amiri)', institution: 'Zabıta Amirliği', type: 'Personel', priority: 2, arrivalTime: '14:30', topic: 'İlçe Pazaryeri Denetim Raporu Sunumu', status: 'Bekliyor' }
    ],
    lastBellRung: 0,
    mayorSchedule: [
      { id: 'ms_1', time: '09:30', date: new Date().toISOString().split('T')[0], title: 'Eldivan Halk Günü Vatandaş Kabulü', location: 'Eldivan Belediye Başkanlığı Makam Salonu', notes: 'Önceden randevu alan vatandaşların dilekçe ve taleplerinin dinlenmesi.', status: 'Tamamlandı' },
      { id: 'ms_2', time: '14:00', date: new Date().toISOString().split('T')[0], title: 'Eldivan Belediye Meclisi Olağan Oturumu', location: 'Belediye Meclis Salonu', notes: 'İmar revizyon planı ve bütçe aktarımları gündem maddeleri.', status: 'Bekliyor' },
      { id: 'ms_3', time: '16:30', date: new Date().toISOString().split('T')[0], title: 'Kirazlık Mahallesi Park ve Saha İncelemesi', location: 'Kirazlık Mahallesi Park Şantiyesi', notes: 'Fen İşleri ve Park Bahçeler Müdürü ile birlikte şantiye denetimi.', status: 'Bekliyor' }
    ],
    documents: [
      { id: 'doc_101', docNo: '2026/7481', title: 'İl Çevre Dairesi Kentsel Dönüşüm Görüş Yazısı', assignedUnit: 'fen_isleri', assignedUnitName: 'Fen İşleri Müdürlüğü', submittedByPerson: 'Kemal Öztürk (Fen İşleri Müdürü)', signType: 'islak', priority: 'acil', targetDate: new Date(Date.now() + 86400000 * 2).toISOString().split('T')[0], status: 'İmza Bekliyor', description: 'Riskli yapı tespit raporları ıslak imzalı üst yazısı.' },
      { id: 'doc_102', docNo: '2026/7495', title: 'Ekim Ayı Personel Maaş & Harcırah Ödeme Emri', assignedUnit: 'muhasebe', assignedUnitName: 'Mali Hizmetler / Muhasebe', submittedByPerson: 'Selim Aksoy (Mali Hizmetler Müdürü)', signType: 'e-imza', priority: 'acil', targetDate: new Date().toISOString().split('T')[0], status: 'İmza Bekliyor', description: 'EBYS üzerinden e-imza onayı bekleyen maaş tahakkuk listesi.' },
      { id: 'doc_103', docNo: '2026/7502', title: 'Pazar Yeri Esnaf İşgaliye Tutanakları', assignedUnit: 'zabita', assignedUnitName: 'Zabıta Amirliği', submittedByPerson: 'Hasan Kaya (Zabıta Amiri)', signType: 'islak', priority: 'normal', targetDate: new Date(Date.now() + 86400000 * 3).toISOString().split('T')[0], status: 'İmza Bekliyor', description: 'Haftalık pazar denetimi encümen sevk evrakı.' }
    ],
    appointments: [
      { id: 'appnt_1', visitorName: 'Mehmet Yılmaz', institution: 'Eldivan Muhtarlar Derneği Başkanı', visitorCategory: 'Kurum / Meclis Üyesi', priority: 'oncelikli', date: new Date().toISOString().split('T')[0], time: '11:30', topic: 'Mahalle Altyapı ve Asfalt Talepleri', status: 'Onay Bekliyor', notes: '5 Mahalle muhtarı katılım sağlayacaktır.' },
      { id: 'appnt_2', visitorName: 'Ali Rıza Çetin', institution: 'Belediye Meclis Üyesi', visitorCategory: 'Kurum / Meclis Üyesi', priority: 'acil', date: new Date().toISOString().split('T')[0], time: '15:00', topic: 'Meclis Komisyon Raporu İstişaresi', status: 'Onay Bekliyor', notes: 'İmar komisyonu gündemi hakkında.' }
    ],
    archivedAppointments: [
      { id: 'arch_appnt_0', visitorName: 'Ahmet Çelik', institution: 'Eldivan Esnaf Odası Heyeti', date: '2026-10-01', time: '10:00', topic: 'Pazar Yeri Düzenlemesi Görüşmesi', status: 'Tamamlandı', notes: 'Yeni tezgah alanları konusunda mutabakata varıldı.', archivedDate: '2026-10-01 11:30', archivedBy: 'sekreter' }
    ],
    archivedDocuments: [
      { id: 'arch_doc_0', docNo: '2026/7300', title: 'Yıllık İhale Şartnamesi Onayı', assignedUnit: 'muhasebe', assignedUnitName: 'Mali Hizmetler', priority: 'sureli', targetDate: '2026-09-30', status: 'Tamamlandı', description: 'Şartname incelendi ve onaylandı.', archivedDate: '2026-09-30 16:00', archivedBy: 'admin' }
    ],
    unitTasks: [
      { id: 'ut_1', title: 'Eldivan İlçe Merkezi Kaldırım Düzenleme İhalesi Dosyası', assignedUnit: 'fen_isleri', assignedUnitName: 'Fen İşleri Müdürlüğü', creator: 'Yönetici (Admin)', date: new Date().toISOString().split('T')[0], status: 'Onay Bekliyor', notes: 'Yaklaşık maliyet cetveli hazırlanması.' }
    ],
    chatMessages: [
      { id: 'msg_1', channel: 'genel', sender: 'admin', senderName: 'Yönetici (Admin)', senderRole: 'Yönetici', text: 'T.C. Eldivan Belediye Başkanlığı Kurumsal İletişim Portalı Hizmete Açılmıştır.', timestamp: new Date().toLocaleString('tr-TR') }
    ],
    auditLogs: [
      { id: 'log_1', timestamp: new Date().toLocaleString('tr-TR'), user: 'admin', userRole: 'Yönetici', action: 'Sistem Başlatma', details: 'Sistem v4.0 kurulumu ve veritabanı başlatıldı.' }
    ],
    customEvents: []
  };
}

function addAuditLog(data, user, userRole, action, details) {
  if (!data.auditLogs) data.auditLogs = [];
  data.auditLogs.unshift({
    id: 'log_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    timestamp: new Date().toLocaleString('tr-TR'),
    user: user || 'Sistem',
    userRole: userRole || 'Birim Kullanıcısı',
    action: action,
    details: details
  });
}

function loadV3Data() {
  try {
    if (fs.existsSync(userDataPath)) {
      const raw = fs.readFileSync(userDataPath, 'utf8');
      const parsed = JSON.parse(raw);
      const def = getDefaultV3Data();
      if (!parsed.users) parsed.users = def.users;
      else {
        // Ensure all new municipal unit accounts exist
        def.users.forEach(du => {
          if (!parsed.users.some(u => u.username.toLowerCase() === du.username.toLowerCase())) {
            parsed.users.push(du);
          }
        });
      }
      if (!parsed.chatMessages) parsed.chatMessages = def.chatMessages;
      if (!parsed.auditLogs) parsed.auditLogs = def.auditLogs;
      if (!parsed.mayorStatus) parsed.mayorStatus = 'kabul-acik';
      if (!parsed.currentGuest) parsed.currentGuest = def.currentGuest;
      if (!parsed.waitingRoom) parsed.waitingRoom = def.waitingRoom;
      if (!parsed.lastBellRung) parsed.lastBellRung = 0;
      return parsed;
    }
  } catch (err) {
    console.error('Error loading V3 data:', err);
  }
  const def = getDefaultV3Data();
  saveV3Data(def);
  return def;
}

function saveV3Data(data, skipCloudPush = false) {
  try {
    if (!skipCloudPush) {
      data.lastUpdatedTimestamp = Date.now();
    }
    if (!data.settings) data.settings = { autostart: true, minimizeToTray: true, notificationTime: '09:00', serverPort: 3500 };
    if (!data.settings.cloudConfig) {
      data.settings.cloudConfig = {
        enabled: true,
        provider: 'github-gist',
        githubToken: unlockBootstrapToken(DEFAULT_CLOUD_SECRET),
        gistId: CLOUD_BOOTSTRAP.gistId,
        githubRepo: CLOUD_BOOTSTRAP.repoName,
        customUrl: '',
        encryptionKey: DEFAULT_CLOUD_SECRET,
        autoGitPush: false,
        lastCloudSync: new Date().toLocaleString('tr-TR'),
        lastCloudStatus: 'synced',
        lastCloudError: ''
      };
    }
    if (!data.settings.cloudConfig.encryptionKey) {
      data.settings.cloudConfig.encryptionKey = DEFAULT_CLOUD_SECRET;
    }
    if (!data.settings.cloudConfig.githubToken) {
      data.settings.cloudConfig.githubToken = unlockBootstrapToken(data.settings.cloudConfig.encryptionKey);
    }
    if (!data.settings.cloudConfig.gistId) {
      data.settings.cloudConfig.gistId = CLOUD_BOOTSTRAP.gistId;
      data.settings.cloudConfig.enabled = true;
    }

    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    const serialized = JSON.stringify(data, null, 2);
    fs.writeFileSync(userDataPath, serialized, 'utf8');

    // Mirror file in project root is ALWAYS AES-256-GCM encrypted so no plaintext leaks to Git/GitHub
    const cleanForCloud = JSON.parse(serialized);
    if (cleanForCloud.settings && cleanForCloud.settings.cloudConfig) {
      cleanForCloud.settings.cloudConfig.githubToken = '';
      cleanForCloud.settings.cloudConfig.encryptionKey = '';
    }
    const encryptedMirror = encryptCloudPayload(cleanForCloud, data.settings.cloudConfig.encryptionKey);
    fs.writeFileSync(cloudMirrorPath, encryptedMirror, 'utf8');

    if (!skipCloudPush && data.settings.cloudConfig && data.settings.cloudConfig.enabled) {
      pushToCloudDatabase(data).catch(err => console.warn('Cloud push error:', err.message));
    }
  } catch (err) {
    console.error('Error saving V3 data:', err);
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
        'User-Agent': 'Eldivan-Belediye-Portal-v4',
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
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ ok: true, status: res.statusCode, data: json });
            } else {
              resolve({ ok: false, status: res.statusCode, error: json.message || raw || `HTTP ${res.statusCode}`, data: json });
            }
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
  if (isCloudSyncing && !forceRun) return { success: false, message: 'Senkronizasyon devam ediyor' };
  const cfg = (data.settings && data.settings.cloudConfig) ? data.settings.cloudConfig : null;
  if (!cfg || (!cfg.enabled && !forceRun)) return { success: false, message: 'Bulut kaydı aktif değil' };

  isCloudSyncing = true;
  try {
    // Clean copy without exposing token or encryption key inside the cloud payload
    const cloudPayload = JSON.parse(JSON.stringify(data));
    if (cloudPayload.settings && cloudPayload.settings.cloudConfig) {
      cloudPayload.settings.cloudConfig.githubToken = '';
      cloudPayload.settings.cloudConfig.encryptionKey = '';
    }
    // Encrypt with AES-256-GCM so nobody outside the municipality can read the cloud JSON
    const contentString = encryptCloudPayload(cloudPayload, cfg.encryptionKey || DEFAULT_CLOUD_SECRET);

    if (cfg.provider === 'github-gist') {
      if (!cfg.githubToken) {
        throw new Error('GitHub Token (Personal Access Token) girilmedi.');
      }
      const authHeaders = { 'Authorization': `Bearer ${cfg.githubToken.trim()}` };

      if (!cfg.gistId || !cfg.gistId.trim()) {
        // Automatically create a new secret Gist on GitHub!
        const createRes = await httpsRequestJson('https://api.github.com/gists', 'POST', authHeaders, {
          description: 'T.C. Eldivan Belediye Başkanlığı - AES-256 Kriptolu Bulut Veritabanı',
          public: false,
          files: {
            'belediye_v3_data.json': { content: contentString }
          }
        });
        if (!createRes.ok) {
          throw new Error('GitHub Gist oluşturulamadı: ' + (createRes.error || createRes.status));
        }
        cfg.gistId = createRes.data.id;
      } else {
        // Update existing Gist
        const updateRes = await httpsRequestJson(`https://api.github.com/gists/${cfg.gistId.trim()}`, 'PATCH', authHeaders, {
          description: `T.C. Eldivan Belediye Başkanlığı - AES-256 Kriptolu Güncelleme: ${new Date().toLocaleString('tr-TR')}`,
          files: {
            'belediye_v3_data.json': { content: contentString }
          }
        });
        if (!updateRes.ok) {
          throw new Error('GitHub Gist güncellenemedi: ' + (updateRes.error || updateRes.status));
        }
      }
    } else if (cfg.provider === 'github-repo') {
      if (!cfg.githubToken || !cfg.githubRepo) {
        throw new Error('GitHub Token ve Repo Adı (kullanici/repo) zorunludur.');
      }
      const repoPath = cfg.githubRepo.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
      const apiUrl = `https://api.github.com/repos/${repoPath}/contents/belediye_v3_data_cloud.json`;
      const authHeaders = { 'Authorization': `Bearer ${cfg.githubToken.trim()}` };

      // Check existing file SHA
      let existingSha = undefined;
      const getRes = await httpsRequestJson(apiUrl, 'GET', authHeaders);
      if (getRes.ok && getRes.data && getRes.data.sha) {
        existingSha = getRes.data.sha;
      }

      const putBody = {
        message: `Kriptolu Veritabanı Güncellemesi - ${new Date().toLocaleString('tr-TR')}`,
        content: Buffer.from(contentString, 'utf8').toString('base64')
      };
      if (existingSha) putBody.sha = existingSha;

      const putRes = await httpsRequestJson(apiUrl, 'PUT', authHeaders, putBody);
      if (!putRes.ok) {
        throw new Error('GitHub Repo yazılamadı: ' + (putRes.error || putRes.status));
      }
    } else if (cfg.provider === 'custom-url') {
      if (!cfg.customUrl) {
        throw new Error('Bulut Veritabanı URL adresi girilmedi.');
      }
      const putRes = await httpsRequestJson(cfg.customUrl.trim(), 'PUT', {}, JSON.parse(contentString));
      if (!putRes.ok) {
        throw new Error('Bulut URL yazılamadı: ' + (putRes.error || putRes.status));
      }
    }

    if (cfg.autoGitPush) {
      exec('git add belediye_v3_data_cloud.json && git commit -m "Otomatik Kriptolu Bulut Kayit" && git push', { cwd: __dirname }, () => {});
    }

    cfg.lastCloudSync = new Date().toLocaleString('tr-TR');
    cfg.lastCloudStatus = 'synced';
    cfg.lastCloudError = '';
    saveV3Data(data, true);
    isCloudSyncing = false;
    return { success: true, gistId: cfg.gistId, lastCloudSync: cfg.lastCloudSync };
  } catch (err) {
    cfg.lastCloudStatus = 'error';
    cfg.lastCloudError = err.message;
    saveV3Data(data, true);
    isCloudSyncing = false;
    return { success: false, message: err.message };
  }
}

async function pullFromCloudDatabase(forceOverwrite = false) {
  if (isCloudSyncing) return { success: false, message: 'Senkronizasyon devam ediyor' };
  const localData = loadV3Data();
  const cfg = (localData.settings && localData.settings.cloudConfig) ? localData.settings.cloudConfig : null;
  if (!cfg || (!cfg.enabled && !forceOverwrite)) return { success: false, message: 'Bulut aktif değil' };

  isCloudSyncing = true;
  try {
    let remoteData = null;
    const secretKey = cfg.encryptionKey || DEFAULT_CLOUD_SECRET;

    if (cfg.provider === 'github-gist') {
      if (!cfg.gistId) throw new Error('Gist ID bulunamadı.');
      const headers = cfg.githubToken ? { 'Authorization': `Bearer ${cfg.githubToken.trim()}` } : {};
      const res = await httpsRequestJson(`https://api.github.com/gists/${cfg.gistId.trim()}`, 'GET', headers);
      if (!res.ok) throw new Error('GitHub Gist okunamadı: ' + (res.error || res.status));
      const fileObj = res.data.files && (res.data.files['belediye_v3_data.json'] || Object.values(res.data.files)[0]);
      if (fileObj && fileObj.content) {
        remoteData = decryptCloudPayload(fileObj.content, secretKey);
      }
    } else if (cfg.provider === 'github-repo') {
      if (!cfg.githubRepo) throw new Error('GitHub Repo adı bulunamadı.');
      const repoPath = cfg.githubRepo.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
      const headers = cfg.githubToken ? { 'Authorization': `Bearer ${cfg.githubToken.trim()}` } : {};
      const res = await httpsRequestJson(`https://api.github.com/repos/${repoPath}/contents/belediye_v3_data_cloud.json`, 'GET', headers);
      if (!res.ok) throw new Error('GitHub Repo okunamadı: ' + (res.error || res.status));
      if (res.data && res.data.content) {
        const decoded = Buffer.from(res.data.content, 'base64').toString('utf8');
        remoteData = decryptCloudPayload(decoded, secretKey);
      }
    } else if (cfg.provider === 'custom-url') {
      if (!cfg.customUrl) throw new Error('Bulut URL bulunamadı.');
      const res = await httpsRequestJson(cfg.customUrl.trim(), 'GET');
      if (!res.ok) throw new Error('Bulut URL okunamadı: ' + (res.error || res.status));
      remoteData = decryptCloudPayload(res.data, secretKey);
    }

    if (remoteData && remoteData.users) {
      const remoteTs = remoteData.lastUpdatedTimestamp || 0;
      const localTs = localData.lastUpdatedTimestamp || 0;

      if (forceOverwrite || remoteTs > localTs) {
        // Preserve local cloudConfig credentials (especially githubToken & encryptionKey)
        remoteData.settings = remoteData.settings || {};
        remoteData.settings.cloudConfig = {
          ...cfg,
          lastCloudSync: new Date().toLocaleString('tr-TR'),
          lastCloudStatus: 'synced',
          lastCloudError: ''
        };
        saveV3Data(remoteData, true);
        isCloudSyncing = false;
        return { success: true, updated: true, lastCloudSync: remoteData.settings.cloudConfig.lastCloudSync };
      }
    }

    cfg.lastCloudSync = new Date().toLocaleString('tr-TR');
    cfg.lastCloudStatus = 'synced';
    cfg.lastCloudError = '';
    saveV3Data(localData, true);
    isCloudSyncing = false;
    return { success: true, updated: false, lastCloudSync: cfg.lastCloudSync };
  } catch (err) {
    cfg.lastCloudStatus = 'error';
    cfg.lastCloudError = err.message;
    saveV3Data(localData, true);
    isCloudSyncing = false;
    return { success: false, message: err.message };
  }
}

function startCloudAutoSyncTimer() {
  setInterval(() => {
    const d = loadV3Data();
    if (d.settings && d.settings.cloudConfig && d.settings.cloudConfig.enabled) {
      pullFromCloudDatabase(false).catch(() => {});
    }
  }, 10000);
}

// FULL ZERO-INSTALLATION LAN HTTP WEB SERVER (WITH SESSION AUTH & FILE WHITELIST)
function startLocalServer() {
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon'
  };

  function getSessionFromReq(req) {
    const token = req.headers['x-auth-token'];
    if (!token || !activeSessions.has(token)) return null;
    return activeSessions.get(token);
  }

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // PROTECTED API ENDPOINT: Requires valid login session token
    if (pathname === '/api/data') {
      const sessionUser = getSessionFromReq(req);
      if (!sessionUser) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Yetkisiz erişim! Lütfen kullanıcı adı ve şifrenizle giriş yapınız.' }));
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
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ip: localIpAddress, port: serverPort, url: `http://${localIpAddress}:${serverPort}` }));
      return;
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { username, password, personnelFullName } = JSON.parse(body);
          const data = loadV3Data();
          const found = data.users.find(u => u.username.toLowerCase() === (username || '').toLowerCase() && u.password === password);
          if (found) {
            if (personnelFullName && personnelFullName.trim()) {
              found.activePersonnel = personnelFullName.trim();
            }
            const authToken = crypto.randomBytes(32).toString('hex');
            activeSessions.set(authToken, {
              username: found.username,
              role: found.role,
              name: found.name,
              createdAt: Date.now()
            });
            const personLabel = found.activePersonnel ? `${found.activePersonnel} (${found.name})` : found.name;
            addAuditLog(data, found.activePersonnel || found.username, found.name, 'Kullanıcı Girişi', `${personLabel} oturum açtı.`);
            saveV3Data(data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, user: found, authToken }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Hatalı kullanıcı adı veya şifre!' }));
          }
        } catch (e) {
          res.writeHead(400); res.end();
        }
      });
      return;
    }

    if (pathname === '/api/action' && req.method === 'POST') {
      const sessionUser = getSessionFromReq(req);
      if (!sessionUser) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: 'Yetkisiz erişim! İşlem yapmak için giriş yapmalısınız.' }));
        return;
      }
      let body = '';
      req.on('data', chunk => body += chunk);
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
            addAuditLog(data, userStr, payload.doc.assignedUnitName, 'İmza / Evrak Girişi', `[${payload.doc.signType === 'e-imza' ? 'E-İmza' : 'Islak İmza'}] Evrak No: ${payload.doc.docNo || '-'} - ${payload.doc.title} (${payload.doc.submittedByPerson || userStr})`);
          } else if (payload.action === 'update-doc-status') {
            const idx = data.documents.findIndex(x => x.id === payload.id);
            if (idx !== -1) {
              const doc = data.documents[idx];
              doc.status = payload.status;
              if (payload.note) doc.decisionNote = payload.note;
              doc.signedBy = userStr;
              doc.signedAt = new Date().toLocaleString('tr-TR');
              if (payload.status === 'Tamamlandı' || payload.status === 'İmzalandı') {
                data.documents.splice(idx, 1);
                if (!data.archivedDocuments) data.archivedDocuments = [];
                data.archivedDocuments.unshift({ ...doc, status: 'İmzalandı', archivedDate: new Date().toLocaleString('tr-TR'), archivedBy: userStr });
                addAuditLog(data, userStr, doc.assignedUnitName || 'Makam/Birim', 'İmza Onaylandı (İmzalandı)', `${doc.title} (${doc.signType === 'e-imza' ? 'E-İmza' : 'Islak İmza'}) imzalandı.`);
              } else if (payload.status === 'Reddedildi') {
                data.documents.splice(idx, 1);
                if (!data.archivedDocuments) data.archivedDocuments = [];
                data.archivedDocuments.unshift({ ...doc, status: 'Reddedildi / İade', archivedDate: new Date().toLocaleString('tr-TR'), archivedBy: userStr });
                addAuditLog(data, userStr, 'Makam/Özel Kalem', 'İmza Reddedildi / İade Edildi', `${doc.title} reddedildi. Not: ${payload.note || '-'}`);
              }
            }
          } else if (payload.action === 'add-appnt') {
            payload.appnt.id = 'appnt_' + Date.now();
            data.appointments.unshift(payload.appnt);
            addAuditLog(data, userStr, payload.appnt.institution || 'Özel Kalem', 'Randevu / Görüşme Talebi', `Talep Eden: ${payload.appnt.visitorName} - Konu: ${payload.appnt.topic}`);
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
                addAuditLog(data, userStr, 'Makam/Özel Kalem', `Randevu ${payload.status}`, `Ziyaretçi: ${appnt.visitorName} (${appnt.date} ${appnt.time})`);
              } else if (payload.status === 'Onaylandı') {
                addAuditLog(data, userStr, 'Makam/Özel Kalem', 'Randevu Gün/Saat Onaylandı', `Ziyaretçi: ${appnt.visitorName} -> Tarih: ${appnt.date} Saat: ${appnt.time}`);
              }
            }
          } else if (payload.action === 'delete-appnt') {
            data.appointments = data.appointments.filter(x => x.id !== payload.id);
            addAuditLog(data, userStr, 'Sekreterya', 'Randevu İptal Edildi', `ID: ${payload.id}`);
          } else if (payload.action === 'edit-appnt') {
            const idx = data.appointments.findIndex(x => x.id === payload.id);
            if (idx !== -1) {
              const a = data.appointments[idx];
              if (payload.appnt.visitorName) a.visitorName = payload.appnt.visitorName;
              if (payload.appnt.institution) a.institution = payload.appnt.institution;
              if (payload.appnt.date) a.date = payload.appnt.date;
              if (payload.appnt.time) a.time = payload.appnt.time;
              if (payload.appnt.topic) a.topic = payload.appnt.topic;
              if (payload.appnt.notes !== undefined) a.notes = payload.appnt.notes;
              if (payload.appnt.status) a.status = payload.appnt.status;
              a.isEdited = true;
              a.lastUpdatedBy = userStr;
              a.lastUpdatedAt = new Date().toLocaleString('tr-TR');
              addAuditLog(data, userStr, 'Sekreterya/Özel Kalem', 'Randevu Düzenlendi', `Ziyaretçi: ${a.visitorName}`);
            }
          } else if (payload.action === 'add-unit-task') {
            payload.task.id = 'ut_' + Date.now();
            if (!payload.task.status) payload.task.status = 'Onay Bekliyor';
            data.unitTasks.unshift(payload.task);
            addAuditLog(data, userStr, payload.task.assignedUnitName, 'Birim Görevi Atandı', `Görev: ${payload.task.title} -> ${payload.task.assignedUnitName}`);
          } else if (payload.action === 'respond-unit-task') {
            const idx = data.unitTasks.findIndex(x => x.id === payload.id);
            if (idx !== -1) {
              const task = data.unitTasks[idx];
              task.status = payload.status; // 'Kabul Edildi', 'Reddedildi', 'Tarih Revize Edildi', 'Tamamlandı'
              if (payload.rejectionReason) task.rejectionReason = payload.rejectionReason;
              if (payload.unitNote) task.unitNote = payload.unitNote;
              if (payload.revisedDate) {
                task.revisedDate = payload.revisedDate;
                task.date = payload.revisedDate;
              }
              task.lastUpdatedBy = userStr;
              task.lastUpdatedAt = new Date().toLocaleString('tr-TR');
              addAuditLog(data, userStr, task.assignedUnitName, `Görev Durumu: ${payload.status}`, `Görev: ${task.title} (Not: ${payload.unitNote || payload.rejectionReason || 'İşlem yapıldı'})`);
            }
          } else if (payload.action === 'send-chat-message') {
            if (!data.chatMessages) data.chatMessages = [];
            const msgObj = {
              id: 'msg_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
              channel: payload.channel || 'genel',
              sender: userStr,
              senderName: payload.senderName || userStr,
              senderRole: payload.senderRole || 'Birim Kullanıcısı',
              text: payload.text,
              timestamp: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
              fullDate: new Date().toLocaleString('tr-TR')
            };
            data.chatMessages.push(msgObj);
            addAuditLog(data, userStr, payload.senderRole, 'Mesaj Gönderildi', `Kanal: #${payload.channel} - ${payload.text.substring(0, 30)}...`);
          } else if (payload.action === 'delete-unit-task') {
            data.unitTasks = data.unitTasks.filter(x => x.id !== payload.id);
            addAuditLog(data, userStr, 'Yönetici/Başkan', 'Birim Görevi Silindi', `Görev ID: ${payload.id}`);
          } else if (payload.action === 'delete-doc') {
            data.documents = data.documents.filter(x => x.id !== payload.id);
            addAuditLog(data, userStr, 'Yönetici/Başkan', 'Evrak Kaydı Silindi', `Evrak ID: ${payload.id}`);
          } else if (payload.action === 'edit-unit-task') {
            const idx = data.unitTasks.findIndex(x => x.id === payload.id);
            if (idx !== -1) {
              const t = data.unitTasks[idx];
              if (payload.title) t.title = payload.title;
              if (payload.date) t.date = payload.date;
              if (payload.notes) t.notes = payload.notes;
              t.isEdited = true;
              t.lastUpdatedBy = userStr;
              t.lastUpdatedAt = new Date().toLocaleString('tr-TR');
              addAuditLog(data, userStr, t.assignedUnitName, 'Birim Görevi Revize Edildi', `Görev: ${t.title}`);
            }
          } else if (payload.action === 'edit-chat-message') {
            if (data.chatMessages) {
              const msg = data.chatMessages.find(m => m.id === payload.id);
              if (msg) {
                msg.text = payload.text + ' (Düzenlendi)';
                msg.isEdited = true;
                addAuditLog(data, userStr, msg.senderRole, 'Mesaj Düzenlendi', `Mesaj ID: ${payload.id}`);
              }
            }
          } else if (payload.action === 'ai-auto-fix') {
            // Auto shift overlapping times
            const timeMap = {};
            (data.mayorSchedule || []).forEach(m => {
              const key = `${m.date}_${m.time}`;
              if (!timeMap[key]) timeMap[key] = [];
              timeMap[key].push(m);
            });
            Object.keys(timeMap).forEach(key => {
              if (timeMap[key].length > 1) {
                for (let i = 1; i < timeMap[key].length; i++) {
                  const item = timeMap[key][i];
                  const [h, min] = item.time.split(':');
                  const nextH = String((parseInt(h, 10) + i) % 24).padStart(2, '0');
                  item.time = `${nextH}:${min}`;
                  item.notes = (item.notes || '') + ' [Yapay Zeka Çakışma Düzenlemesi]';
                }
              }
            });
            addAuditLog(data, userStr, 'Yapay Zeka Denetçisi', 'Otomatik Çakışma Düzeltme', 'Program saat çakışmaları yapay zeka tarafından otomatik güncellendi.');
          } else if (payload.action === 'update-mayor-status') {
            data.mayorStatus = payload.status;
            const statusNames = { 'kabul-acik': 'Makamda (Kabul Açık)', 'toplantida': 'Toplantıda', 'ilce-disinda': 'İlçe Dışında', 'kapali': 'Meşgul / Kapalı' };
            addAuditLog(data, userStr, 'Özel Kalem/Makam', 'Makam Durumu Değişti', `Yeni Durum: ${statusNames[payload.status] || payload.status}`);
          } else if (payload.action === 'complete-guest-take-next') {
            if (data.currentGuest && data.currentGuest.name) {
              if (!data.archivedAppointments) data.archivedAppointments = [];
              data.archivedAppointments.unshift({
                id: 'arch_guest_' + Date.now(),
                visitorName: data.currentGuest.name,
                institution: data.currentGuest.institution || 'Makam Görüşmesi',
                topic: data.currentGuest.topic || 'Genel Konular',
                date: new Date().toISOString().split('T')[0],
                time: data.currentGuest.startTime || '14:00',
                status: 'Tamamlandı',
                archivedDate: new Date().toLocaleString('tr-TR'),
                archivedBy: userStr
              });
            }
            if (data.waitingRoom && data.waitingRoom.length > 0) {
              const next = data.waitingRoom.shift();
              data.currentGuest = {
                name: next.visitorName,
                institution: next.institution || 'Ziyaretçi',
                topic: next.topic || 'Genel Görüşme',
                startTime: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
                elapsedMinutes: 0
              };
              addAuditLog(data, userStr, 'Özel Kalem/Makam', 'Sıradaki Ziyaretçi Alındı', `İçeri Alınan: ${next.visitorName}`);
            } else {
              data.currentGuest = { name: 'Makam Boş', institution: 'Bekleyen Yok', topic: '--', startTime: '--:--', elapsedMinutes: 0 };
              addAuditLog(data, userStr, 'Özel Kalem/Makam', 'Makam Görüşmesi Tamamlandı', 'Salonda bekleyen ziyaretçi kalmadı.');
            }
          } else if (payload.action === 'clear-room') {
            if (data.currentGuest && data.currentGuest.name && data.currentGuest.name !== 'Makam Boş') {
              if (!data.archivedAppointments) data.archivedAppointments = [];
              data.archivedAppointments.unshift({
                id: 'arch_guest_' + Date.now(),
                visitorName: data.currentGuest.name,
                institution: data.currentGuest.institution || 'Makam Görüşmesi',
                topic: data.currentGuest.topic || 'Genel Konular',
                date: new Date().toISOString().split('T')[0],
                time: data.currentGuest.startTime || '14:00',
                status: 'Tamamlandı',
                archivedDate: new Date().toLocaleString('tr-TR'),
                archivedBy: userStr
              });
            }
            data.currentGuest = { name: 'Makam Boş', institution: 'Kabul Yok', topic: '--', startTime: '--:--', elapsedMinutes: 0 };
            addAuditLog(data, userStr, 'Özel Kalem', 'Makam Boşaltıldı', 'Makam odasındaki ziyaretçi çıkışı sağlandı.');
          } else if (payload.action === 'ring-bell') {
            data.lastBellRung = Date.now();
            addAuditLog(data, userStr, 'Makam Kokpiti', 'Makam Zili Çalındı', 'Başkan Makam Ziline bastı.');
          } else if (payload.action === 'add-waiting-room') {
            if (!data.waitingRoom) data.waitingRoom = [];
            payload.item.id = 'wr_' + Date.now();
            if (!payload.item.priority) payload.item.priority = 3;
            if (!payload.item.status) payload.item.status = 'Bekliyor';
            data.waitingRoom.push(payload.item);
            data.waitingRoom.sort((a, b) => (a.priority || 3) - (b.priority || 3));
            addAuditLog(data, userStr, payload.item.institution || 'Özel Kalem', 'Bekleme Salonuna Eklendi', `Ziyaretçi: ${payload.item.visitorName} (${payload.item.type || 'Randevusuz'})`);
          } else if (payload.action === 'admit-waiting-guest') {
            if (data.waitingRoom) {
              const idx = data.waitingRoom.findIndex(x => x.id === payload.id);
              if (idx !== -1) {
                const guestToAdmit = data.waitingRoom.splice(idx, 1)[0];
                if (data.currentGuest && data.currentGuest.name && data.currentGuest.name !== 'Makam Boş') {
                  if (!data.archivedAppointments) data.archivedAppointments = [];
                  data.archivedAppointments.unshift({
                    id: 'arch_guest_' + Date.now(),
                    visitorName: data.currentGuest.name,
                    institution: data.currentGuest.institution || 'Makam Görüşmesi',
                    topic: data.currentGuest.topic || 'Genel Konular',
                    date: new Date().toISOString().split('T')[0],
                    time: data.currentGuest.startTime || '14:00',
                    status: 'Tamamlandı',
                    archivedDate: new Date().toLocaleString('tr-TR'),
                    archivedBy: userStr
                  });
                }
                data.currentGuest = {
                  name: guestToAdmit.visitorName,
                  institution: guestToAdmit.institution || guestToAdmit.type || 'Ziyaretçi',
                  topic: guestToAdmit.topic || 'Genel Görüşme',
                  startTime: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
                  elapsedMinutes: 0
                };
                addAuditLog(data, userStr, 'Makam/Özel Kalem', 'Bekleme Salonundan İçeri Alındı', `Kabul Edilen: ${guestToAdmit.visitorName}`);
              }
            }
          } else if (payload.action === 'convert-waiting-to-appnt') {
            if (data.waitingRoom) {
              const idx = data.waitingRoom.findIndex(x => x.id === payload.id);
              if (idx !== -1) {
                const w = data.waitingRoom.splice(idx, 1)[0];
                if (!data.appointments) data.appointments = [];
                data.appointments.unshift({
                  id: 'appnt_' + Date.now(),
                  visitorName: w.visitorName,
                  institution: w.institution || w.type || 'Vatandaş',
                  visitorCategory: w.type || 'Randevusuz Vatandaş',
                  priority: w.priority === 1 ? 'acil' : w.priority === 2 ? 'oncelikli' : 'normal',
                  date: payload.date || new Date().toISOString().split('T')[0],
                  time: payload.time || '14:00',
                  topic: w.topic || 'Görüşme Talebi',
                  status: 'Onaylandı',
                  notes: 'Bekleme salonundan randevuya dönüştürüldü.',
                  creator: userStr
                });
                addAuditLog(data, userStr, 'Makam/Özel Kalem', 'Randevusuz Ziyaretçi Randevuya Dönüştürüldü', `${w.visitorName} -> ${payload.date} ${payload.time}`);
              }
            }
          } else if (payload.action === 'update-waiting-priority') {
            if (data.waitingRoom) {
              const idx = data.waitingRoom.findIndex(x => x.id === payload.id);
              if (idx !== -1) {
                if (payload.priority !== undefined) {
                  data.waitingRoom[idx].priority = Number(payload.priority);
                  data.waitingRoom.sort((a, b) => (a.priority || 3) - (b.priority || 3));
                } else if (payload.direction === 'up' && idx > 0) {
                  const temp = data.waitingRoom[idx - 1];
                  data.waitingRoom[idx - 1] = data.waitingRoom[idx];
                  data.waitingRoom[idx] = temp;
                } else if (payload.direction === 'down' && idx < data.waitingRoom.length - 1) {
                  const temp = data.waitingRoom[idx + 1];
                  data.waitingRoom[idx + 1] = data.waitingRoom[idx];
                  data.waitingRoom[idx] = temp;
                }
                addAuditLog(data, userStr, 'Makam/Özel Kalem', 'Bekleme Salonu Öncelik Sırası Güncellendi', `Ziyaretçi: ${data.waitingRoom[idx] ? data.waitingRoom[idx].visitorName : payload.id}`);
              }
            }
          } else if (payload.action === 'delete-waiting-room') {
            if (data.waitingRoom) {
              const target = data.waitingRoom.find(x => x.id === payload.id);
              data.waitingRoom = data.waitingRoom.filter(x => x.id !== payload.id);
              addAuditLog(data, userStr, 'Makam/Özel Kalem', 'Bekleme Salonundan Reddedildi / Çıkarıldı', `Ziyaretçi: ${target ? target.visitorName : payload.id}`);
            }
          } else if (payload.action === 'change-user-credentials') {
            const userObj = data.users.find(u => u.username.toLowerCase() === payload.targetUsername.toLowerCase());
            if (userObj) {
              userObj.username = payload.newUsername.trim();
              userObj.password = payload.newPassword;
              userObj.mustChangePassword = false;
              addAuditLog(data, payload.targetUsername, userObj.name, 'Kullanıcı Şifre/Kullanıcı Adı Güncelledi', `Yeni kullanıcı adı: ${userObj.username}`);
            }
          } else if (payload.action === 'admin-save-user') {
            if (!data.users) data.users = [];
            const idx = data.users.findIndex(u => u.username.toLowerCase() === (payload.userObj.originalUsername || payload.userObj.username).toLowerCase());
            if (idx !== -1) {
              data.users[idx] = { ...data.users[idx], ...payload.userObj };
              delete data.users[idx].originalUsername;
              addAuditLog(data, userStr, 'Yönetici', 'Kullanıcı Bilgileri Güncellendi', `Kullanıcı: ${payload.userObj.username}`);
            } else {
              const newUser = {
                username: payload.userObj.username.trim(),
                password: payload.userObj.password || '123',
                name: payload.userObj.name || payload.userObj.username,
                role: payload.userObj.role || 'yazi_isleri',
                mustChangePassword: payload.userObj.mustChangePassword !== undefined ? payload.userObj.mustChangePassword : true,
                permissions: payload.userObj.permissions || {
                  perm_daily: true, perm_mayor: true, perm_docs: true, perm_archive: true, perm_tasks: true, perm_chat: true, perm_ai: true, perm_calendar: true, perm_audit: true
                }
              };
              data.users.push(newUser);
              addAuditLog(data, userStr, 'Yönetici', 'Yeni Kullanıcı Oluşturuldu', `Yeni Kullanıcı: ${newUser.username} (${newUser.name})`);
            }
          } else if (payload.action === 'admin-delete-user') {
            data.users = data.users.filter(u => u.username.toLowerCase() !== payload.targetUsername.toLowerCase());
            addAuditLog(data, userStr, 'Yönetici', 'Kullanıcı Hesabı Silindi', `Silinen Kullanıcı: ${payload.targetUsername}`);
          }

          saveV3Data(data);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: sanitizeDataForUser(data, sessionUser) }));
        } catch (e) {
          res.writeHead(400); res.end();
        }
      });
      return;
    }

    if (pathname === '/api/cloud-sync' && req.method === 'POST') {
      const sessionUser = getSessionFromReq(req);
      if (!sessionUser) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, message: 'Yetkisiz erişim!' }));
        return;
      }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          const data = loadV3Data();
          if (!data.settings) data.settings = {};
          if (!data.settings.cloudConfig) data.settings.cloudConfig = {};

          if (payload.subAction === 'save-config') {
            data.settings.cloudConfig = {
              ...data.settings.cloudConfig,
              ...payload.cloudConfig
            };
            addAuditLog(data, payload.user || 'Yönetici', 'Sistem', 'Bulut Veritabanı Ayarları Güncellendi', `Sağlayıcı: ${data.settings.cloudConfig.provider} (Aktif: ${data.settings.cloudConfig.enabled})`);
            saveV3Data(data, true);
            let syncRes = { success: true };
            if (data.settings.cloudConfig.enabled) {
              syncRes = await pushToCloudDatabase(data, true);
            }
            const fresh = loadV3Data();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: syncRes.success, message: syncRes.message || '', data: sanitizeDataForUser(fresh, sessionUser) }));
            return;
          } else if (payload.subAction === 'push-now') {
            const syncRes = await pushToCloudDatabase(data, true);
            const fresh = loadV3Data();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: syncRes.success, message: syncRes.message || '', data: sanitizeDataForUser(fresh, sessionUser) }));
            return;
          } else if (payload.subAction === 'pull-now') {
            const pullRes = await pullFromCloudDatabase(true);
            const fresh = loadV3Data();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: pullRes.success, message: pullRes.message || '', data: sanitizeDataForUser(fresh, sessionUser) }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: sanitizeDataForUser(data, sessionUser) }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: err.message }));
        }
      });
      return;
    }

    // STRICT STATIC FILE WHITELIST (Blocks direct access to belediye_v3_data_cloud.json, main.js, .git, etc.)
    const allowedStaticFiles = ['/', '/index.html', '/styles.css', '/renderer.js', '/icon.png', '/events_db.json'];
    if (!allowedStaticFiles.includes(pathname)) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>403 - Gizli Alan (Yetkisiz Erişim Engellendi)</h1>');
      return;
    }

    let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>404 - Sayfa Bulunamadı</h1>');
        } else {
          res.writeHead(500);
          res.end('Server Error: ' + err.code);
        }
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content, 'utf-8');
      }
    });
  });

  server.listen(serverPort, '0.0.0.0', () => {
    console.log(`Eldivan Belediye v3.0 LAN Web Server running at http://${localIpAddress}:${serverPort}`);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1340,
    height: 890,
    minWidth: 1060,
    minHeight: 720,
    title: 'T.C. Eldivan Belediye Başkanlığı - Takvim & Ajanda Portalı v3.0',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    autoHideMenuBar: true,
    show: false
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    const isHidden = process.argv.includes('--hidden');
    if (!isHidden) mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    const data = loadV3Data();
    if (!isQuitting && data.settings.minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
      if (Notification.isSupported()) {
        new Notification({
          title: 'Eldivan Belediye Takvimi v3.0 Arka Planda',
          body: 'Uygulama tepsisinde çalışıyor. Ağ bağlantısı açık.',
          icon: path.join(__dirname, 'icon.png'),
          silent: true
        }).show();
      }
    }
    return false;
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('T.C. Eldivan Belediye Başkanlığı Takvimi v3.0');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Eldivan Belediye Takvimini Aç', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: `Ağ Adresi: http://${localIpAddress}:${serverPort}`, enabled: false },
    { type: 'separator' },
    { label: 'Çıkış', click: () => { isQuitting = true; app.quit(); } }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

app.whenReady().then(() => {
  loadV3Data();
  createWindow();
  createTray();
  startLocalServer();
  startCloudAutoSyncTimer();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => { isQuitting = true; });

// Electron IPC Handlers
ipcMain.handle('get-events-db', () => JSON.parse(fs.readFileSync(dbPath, 'utf8')));
ipcMain.handle('get-v2-data', () => loadV3Data());
ipcMain.handle('save-v2-data', (e, data) => { saveV3Data(data); return true; });

ipcMain.handle('login-user', (e, { username, password, personnelFullName }) => {
  const data = loadV3Data();
  const found = data.users.find(u => u.username.toLowerCase() === username.toLowerCase() && u.password === password);
  if (found) {
    if (personnelFullName && personnelFullName.trim()) {
      found.activePersonnel = personnelFullName.trim();
    }
    const personLabel = found.activePersonnel ? `${found.activePersonnel} (${found.name})` : found.name;
    addAuditLog(data, found.activePersonnel || found.username, found.name, 'Kullanıcı Girişi', `${personLabel} oturum açtı.`);
    saveV3Data(data);
    return { success: true, user: found };
  }
  return { success: false, message: 'Kullanıcı adı veya şifre hatalı!' };
});

ipcMain.handle('validate-admin-password', (e, pass) => pass === '123' || pass === 'admin');

ipcMain.handle('add-mayor-engagement', (e, item) => {
  const data = loadV3Data();
  item.id = 'ms_' + Date.now();
  data.mayorSchedule.unshift(item);
  saveV3Data(data);
  return data.mayorSchedule;
});

ipcMain.handle('delete-mayor-engagement', (e, id) => {
  const data = loadV3Data();
  data.mayorSchedule = data.mayorSchedule.filter(x => x.id !== id);
  saveV3Data(data);
  return data.mayorSchedule;
});

ipcMain.handle('add-document', (e, doc) => {
  const data = loadV3Data();
  doc.id = 'doc_' + Date.now();
  data.documents.unshift(doc);
  saveV3Data(data);
  return data.documents;
});

ipcMain.handle('update-document-status', (e, { id, status, user }) => {
  const data = loadV3Data();
  const idx = data.documents.findIndex(x => x.id === id);
  if (idx !== -1) {
    const doc = data.documents[idx];
    doc.status = status;
    if (status === 'Tamamlandı') {
      data.documents.splice(idx, 1);
      if (!data.archivedDocuments) data.archivedDocuments = [];
      data.archivedDocuments.unshift({ ...doc, archivedDate: new Date().toLocaleString('tr-TR'), archivedBy: user || 'Sistem' });
    }
  }
  saveV3Data(data);
  return data;
});

ipcMain.handle('add-appointment', (e, appnt) => {
  const data = loadV3Data();
  appnt.id = 'appnt_' + Date.now();
  data.appointments.unshift(appnt);
  saveV3Data(data);
  return data.appointments;
});

ipcMain.handle('update-appointment-status', (e, { id, status, user }) => {
  const data = loadV3Data();
  const idx = data.appointments.findIndex(x => x.id === id);
  if (idx !== -1) {
    const appnt = data.appointments[idx];
    appnt.status = status;
    if (status === 'Onaylandı' || status === 'Tamamlandı') {
      data.appointments.splice(idx, 1);
      if (!data.archivedAppointments) data.archivedAppointments = [];
      data.archivedAppointments.unshift({ ...appnt, archivedDate: new Date().toLocaleString('tr-TR'), archivedBy: user || 'Sistem' });
    }
  }
  saveV3Data(data);
  return data;
});

ipcMain.handle('assign-unit-task', (e, task) => {
  const data = loadV3Data();
  task.id = 'ut_' + Date.now();
  data.unitTasks.unshift(task);
  saveV3Data(data);
  return data.unitTasks;
});

ipcMain.handle('save-jpg-image', (e, { base64Data, fileName }) => {
  try {
    const desktopDir = path.join(os.homedir(), 'Desktop');
    const targetFile = path.join(desktopDir, fileName);
    const base64Image = base64Data.replace(/^data:image\/jpeg;base64,/, '');
    fs.writeFileSync(targetFile, base64Image, 'base64');
    return { success: true, filePath: targetFile };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-server-info', () => ({ ip: localIpAddress, port: serverPort, url: `http://${localIpAddress}:${serverPort}` }));
ipcMain.handle('get-settings', () => loadV3Data().settings);
ipcMain.handle('save-settings', (e, s) => { const d = loadV3Data(); d.settings = { ...d.settings, ...s }; saveV3Data(d); return d.settings; });
ipcMain.handle('send-notification', (e, { title, body }) => { if (Notification.isSupported()) new Notification({ title, body, icon: path.join(__dirname, 'icon.png') }).show(); return true; });
ipcMain.handle('toggle-autostart', (e, enable) => { app.setLoginItemSettings({ openAtLogin: enable, path: process.execPath, args: ['--hidden'] }); const d = loadV3Data(); d.settings.autostart = enable; saveV3Data(d); return enable; });
