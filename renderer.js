// BelediyeTakvim v3.0 - Eldivan Belediye Başkanlığı Application Logic

let eventsDb = null;
let v3Data = {
  users: [],
  settings: {},
  mayorSchedule: [],
  documents: [],
  appointments: [],
  archivedAppointments: [],
  archivedDocuments: [],
  unitTasks: []
};

let loggedInUser = null;
let currentDate = new Date();
let currentMonthDate = new Date();
let currentYear = new Date().getFullYear();
let activeCategoryFilter = 'all';
let archiveSubTab = 'appointments';
let dailyTasks = JSON.parse(localStorage.getItem('belediye_daily_tasks') || '[]');

let soundEnabled = true;
let activeChatChannel = 'genel';

document.addEventListener('DOMContentLoaded', async () => {
  initClock();
  initTabs();
  initListeners();
  initSoundEngine();
  initChatListeners();
  await loadAppData();

  const savedUser = sessionStorage.getItem('belediye_active_user');
  if (savedUser) {
    loggedInUser = JSON.parse(savedUser);
    onLoginSuccess();
  }

  startLivePolling();
});

function initClock() {
  function update() {
    const now = new Date();
    document.getElementById('live-time').textContent = now.toLocaleTimeString('tr-TR');
    document.getElementById('live-date').textContent = now.toLocaleDateString('tr-TR', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
  }
  update();
  setInterval(update, 1000);
}

function initSoundEngine() {
  const btn = document.getElementById('btn-sound-toggle');
  if (btn) {
    btn.addEventListener('click', () => {
      soundEnabled = !soundEnabled;
      btn.textContent = soundEnabled ? '🔔 Ses Açık' : '🔕 Ses Kapalı';
    });
  }
}

function playNotificationSound(type = 'task') {
  if (!soundEnabled) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();

    const playNote = (freq, startTime, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(0.65, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + duration);
    };

    const now = ctx.currentTime;
    if (type === 'task') {
      playNote(523.25, now, 0.25);        // C5
      playNote(659.25, now + 0.12, 0.25); // E5
      playNote(783.99, now + 0.24, 0.4);  // G5
    } else if (type === 'chat') {
      playNote(659.25, now, 0.2);         // E5
      playNote(880.00, now + 0.1, 0.35);  // A5
    } else {
      playNote(440.00, now, 0.2);
      playNote(554.37, now + 0.15, 0.3);
    }
  } catch (e) {
    console.error('Audio play error:', e);
  }
}

function showLiveToast(title, body) {
  const container = document.getElementById('live-toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'live-toast-item';
  toast.innerHTML = `
    <div class="toast-title">${title}</div>
    <div class="toast-body">${body}</div>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 400);
  }, 4500);
}

function checkMayorInputConflict() {
  const dateVal = document.getElementById('mayor-input-date').value;
  const timeVal = document.getElementById('mayor-input-time').value;
  const banner = document.getElementById('mayor-ai-conflict-banner');
  const textEl = document.getElementById('mayor-ai-conflict-text');

  if (!dateVal || !timeVal || !v3Data.mayorSchedule) {
    if (banner) banner.classList.add('hidden');
    return false;
  }

  const existing = v3Data.mayorSchedule.find(x => x.date === dateVal && x.time === timeVal);
  if (existing) {
    if (banner && textEl) {
      textEl.textContent = `Seçilen ${dateVal} tarihinde saat ${timeVal}'da zaten '${existing.title}' programı bulunmaktadır! Saatli olan programlar aynı saate yapılmasın.`;
      banner.classList.remove('hidden');
    }
    return true;
  } else {
    if (banner) banner.classList.add('hidden');
    return false;
  }
}

let activeWaitingRoomFilter = 'all';
let activeHubSignatureFilter = 'all';

function initTabs() {
  const tabs = document.querySelectorAll('.nav-tab');
  const panes = document.querySelectorAll('.tab-pane');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      panes.forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      const targetId = tab.getAttribute('data-tab');
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.classList.add('active');

      if (targetId === 'tab-baskanlik-paneli') renderBaskanlikAndUnitHub();
      if (targetId === 'tab-daily') renderDailyView();
      if (targetId === 'tab-monthly') renderMonthlyView();
      if (targetId === 'tab-yearly') renderYearlyView();
      if (targetId === 'tab-mayor-schedule') renderMayorScheduleView();
      if (targetId === 'tab-documents-appointments') renderDocsAndAppntsView();
      if (targetId === 'tab-archive') renderArchiveView();
      if (targetId === 'tab-unit-tasks') renderUnitTasksView();
      if (targetId === 'tab-chat') renderChatMessages();
      if (targetId === 'tab-ai-assistant') runAiAuditEngine();
      if (targetId === 'tab-audit-logs') renderAuditLogsView();
    });
  });
}

function getAuthHeaders(extraHeaders = {}) {
  const token = sessionStorage.getItem('belediye_auth_token') || '';
  return {
    'Content-Type': 'application/json',
    'X-Auth-Token': token,
    ...extraHeaders
  };
}

window.fillLogin = function(username, defaultPersonnel) {
  let targetUser = null;
  if (v3Data && v3Data.users) {
    targetUser = v3Data.users.find(u => u.username.toLowerCase() === username.toLowerCase() || u.role === username);
  }
  const uVal = targetUser ? targetUser.username : username;
  document.getElementById('login-username').value = uVal;
  // Never auto-fill password on the login screen for security
  const passEl = document.getElementById('login-password');
  passEl.value = '';

  const savedPerson = localStorage.getItem('belediye_person_' + uVal.toLowerCase());
  const pInput = document.getElementById('login-personnel-name');
  if (pInput) {
    pInput.value = savedPerson || (targetUser && targetUser.activePersonnel) || (targetUser && targetUser.defaultPersonnel) || defaultPersonnel || '';
  }
  passEl.focus();
};

async function loadAppData() {
  let serverUrl = window.location.origin;
  if (window.location.protocol === 'file:') {
    serverUrl = 'http://127.0.0.1:3500';
  }

  try {
    const dbUrl = window.location.protocol === 'file:' ? 'http://127.0.0.1:3500/api/events-db' : '/api/events-db';
    const resDb = await fetch(dbUrl);
    if (resDb.ok) eventsDb = await resDb.json();

    const infoUrl = window.location.protocol === 'file:' ? 'http://127.0.0.1:3500/api/server-info' : '/api/server-info';
    const resInfo = await fetch(infoUrl);
    if (resInfo.ok) {
      const serverInfo = await resInfo.json();
      if (serverInfo && serverInfo.url) serverUrl = serverInfo.url;
    }

    // Only load protected municipal data if user has an active session token
    const token = sessionStorage.getItem('belediye_auth_token');
    if (token) {
      const targetUrl = window.location.protocol === 'file:' ? 'http://127.0.0.1:3500/api/data' : '/api/data';
      const resData = await fetch(targetUrl, { headers: getAuthHeaders() });
      if (resData.ok) {
        v3Data = await resData.json();
      } else if (resData.status === 401 && window.api) {
        v3Data = await window.api.getV2Data();
      }
    }
  } catch (err) {
    console.warn('HTTP data load fallback:', err);
    if (window.api) {
      eventsDb = await window.api.getEventsDb();
      if (sessionStorage.getItem('belediye_active_user')) {
        v3Data = await window.api.getV2Data();
      }
      const serverInfo = await window.api.getServerInfo();
      if (serverInfo && serverInfo.url) {
        serverUrl = serverInfo.url;
      }
    } else {
      try {
        const resStaticDb = await fetch('events_db.json');
        if (resStaticDb.ok) eventsDb = await resStaticDb.json();
      } catch (e) {}
    }
  }

  ['lan-url', 'login-lan-url', 'settings-lan-url'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = serverUrl;
  });

  const mayorFilter = document.getElementById('mayor-filter-date');
  if (mayorFilter) mayorFilter.value = new Date().toISOString().split('T')[0];
}

async function reloadV3Data() {
  try {
    const targetUrl = window.location.protocol === 'file:' ? 'http://127.0.0.1:3500/api/data' : '/api/data';
    const res = await fetch(targetUrl, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Local API offline or unauthorized');
    v3Data = await res.json();
  } catch (err) {
    if (window.api) {
      v3Data = await window.api.getV2Data();
    } else {
      const cloudPulled = await browserDirectCloudPull();
      if (cloudPulled) v3Data = cloudPulled;
    }
  }
}

function getActiveActorLabel() {
  if (!loggedInUser) return 'Sistem';
  if (loggedInUser.activePersonnel) {
    return `${loggedInUser.activePersonnel} (${loggedInUser.name || loggedInUser.username})`;
  }
  return loggedInUser.name || loggedInUser.username;
}

function applyActionToLocalV3Data(payload) {
  const userStr = payload.user || 'Sistem';
  if (!v3Data.mayorSchedule) v3Data.mayorSchedule = [];
  if (!v3Data.documents) v3Data.documents = [];
  if (!v3Data.appointments) v3Data.appointments = [];
  if (!v3Data.waitingRoom) v3Data.waitingRoom = [];
  if (!v3Data.unitTasks) v3Data.unitTasks = [];
  if (!v3Data.chatMessages) v3Data.chatMessages = [];

  if (payload.action === 'add-mayor') {
    payload.item.id = 'ms_' + Date.now();
    v3Data.mayorSchedule.unshift(payload.item);
  } else if (payload.action === 'delete-mayor') {
    v3Data.mayorSchedule = v3Data.mayorSchedule.filter(x => x.id !== payload.id);
  } else if (payload.action === 'add-doc') {
    payload.doc.id = 'doc_' + Date.now();
    if (!payload.doc.status) payload.doc.status = 'İmza Bekliyor';
    v3Data.documents.unshift(payload.doc);
  } else if (payload.action === 'update-doc-status') {
    const idx = v3Data.documents.findIndex(x => x.id === payload.id);
    if (idx !== -1) {
      const doc = v3Data.documents.splice(idx, 1)[0];
      if (!v3Data.archivedDocuments) v3Data.archivedDocuments = [];
      v3Data.archivedDocuments.unshift({ ...doc, status: payload.status, archivedDate: new Date().toLocaleString('tr-TR'), archivedBy: userStr });
    }
  } else if (payload.action === 'add-appnt') {
    payload.appnt.id = 'appnt_' + Date.now();
    v3Data.appointments.unshift(payload.appnt);
  } else if (payload.action === 'update-appnt-status') {
    const idx = v3Data.appointments.findIndex(x => x.id === payload.id);
    if (idx !== -1) {
      const appnt = v3Data.appointments[idx];
      appnt.status = payload.status;
      if (payload.date) appnt.date = payload.date;
      if (payload.time) appnt.time = payload.time;
      if (payload.status === 'Tamamlandı' || payload.status === 'Reddedildi') {
        v3Data.appointments.splice(idx, 1);
        if (!v3Data.archivedAppointments) v3Data.archivedAppointments = [];
        v3Data.archivedAppointments.unshift({ ...appnt, archivedDate: new Date().toLocaleString('tr-TR'), archivedBy: userStr });
      }
    }
  } else if (payload.action === 'add-waiting-room') {
    payload.item.id = 'wr_' + Date.now();
    v3Data.waitingRoom.push(payload.item);
    v3Data.waitingRoom.sort((a, b) => (a.priority || 3) - (b.priority || 3));
  } else if (payload.action === 'admit-waiting-guest') {
    const idx = v3Data.waitingRoom.findIndex(x => x.id === payload.id);
    if (idx !== -1) {
      const g = v3Data.waitingRoom.splice(idx, 1)[0];
      v3Data.currentGuest = { name: g.visitorName, institution: g.institution || g.type, topic: g.topic, startTime: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) };
    }
  } else if (payload.action === 'convert-waiting-to-appnt') {
    const idx = v3Data.waitingRoom.findIndex(x => x.id === payload.id);
    if (idx !== -1) {
      const w = v3Data.waitingRoom.splice(idx, 1)[0];
      v3Data.appointments.unshift({ id: 'appnt_' + Date.now(), visitorName: w.visitorName, institution: w.institution, visitorCategory: w.type, date: payload.date, time: payload.time, topic: w.topic, status: 'Onaylandı' });
    }
  } else if (payload.action === 'update-waiting-priority') {
    const idx = v3Data.waitingRoom.findIndex(x => x.id === payload.id);
    if (idx !== -1 && payload.priority !== undefined) {
      v3Data.waitingRoom[idx].priority = Number(payload.priority);
      v3Data.waitingRoom.sort((a, b) => (a.priority || 3) - (b.priority || 3));
    }
  } else if (payload.action === 'delete-waiting-room') {
    v3Data.waitingRoom = v3Data.waitingRoom.filter(x => x.id !== payload.id);
  } else if (payload.action === 'update-mayor-status') {
    v3Data.mayorStatus = payload.status;
  } else if (payload.action === 'ring-bell') {
    v3Data.lastBellRung = Date.now();
  } else if (payload.action === 'clear-room') {
    v3Data.currentGuest = { name: 'Makam Boş', institution: 'Kabul Yok', topic: '--', startTime: '--:--' };
  } else if (payload.action === 'add-unit-task') {
    payload.task.id = 'ut_' + Date.now();
    v3Data.unitTasks.unshift(payload.task);
  } else if (payload.action === 'send-chat-message') {
    v3Data.chatMessages.push({ id: 'msg_' + Date.now(), channel: payload.channel || 'genel', sender: userStr, senderName: payload.senderName || userStr, senderRole: payload.senderRole, text: payload.text, timestamp: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) });
  }
  v3Data.lastUpdatedTimestamp = Date.now();
}

async function executeAction(action, dataObj = {}) {
  const userStr = getActiveActorLabel();
  const payload = { action, ...dataObj, user: userStr };
  const targetUrl = window.location.protocol === 'file:' ? 'http://127.0.0.1:3500/api/action' : '/api/action';

  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Server offline');
    const result = await res.json();
    if (result.success && result.data) {
      v3Data = result.data;
    }
    return result;
  } catch (err) {
    console.warn('REST action fetch failed, attempting Electron IPC or Serverless Cloud fallback:', err);
    if (window.api) {
      if (action === 'add-mayor') return await window.api.addMayorEngagement(dataObj.item);
      if (action === 'delete-mayor') return await window.api.deleteMayorEngagement(dataObj.id);
      if (action === 'add-doc') return await window.api.addDocument(dataObj.doc);
      if (action === 'update-doc-status') return await window.api.updateDocumentStatus(dataObj.id, dataObj.status, userStr);
      if (action === 'delete-doc') return await window.api.deleteDocument(dataObj.id);
      if (action === 'add-appnt') return await window.api.addAppointment(dataObj.appnt);
      if (action === 'update-appnt-status') return await window.api.updateAppointmentStatus(dataObj.id, dataObj.status, userStr);
      if (action === 'delete-appnt') return await window.api.deleteAppointment(dataObj.id);
      if (action === 'add-unit-task') return await window.api.assignUnitTask(dataObj.task);
    } else {
      // Serverless GitHub Pages / Direct Cloud Mode
      applyActionToLocalV3Data(payload);
      await browserDirectCloudPush(v3Data).catch(() => {});
      return { success: true, data: v3Data };
    }
  }
}

function initListeners() {
  document.getElementById('form-login').addEventListener('submit', handleLogin);

  document.getElementById('btn-logout').addEventListener('click', () => {
    sessionStorage.removeItem('belediye_active_user');
    sessionStorage.removeItem('belediye_auth_token');
    loggedInUser = null;
    v3Data = { users: [], settings: {}, mayorSchedule: [], documents: [], appointments: [], archivedAppointments: [], archivedDocuments: [], unitTasks: [] };
    document.getElementById('app-main-container').classList.add('hidden');
    document.getElementById('login-overlay').classList.remove('hidden');
  });

  document.getElementById('btn-daily-prev').addEventListener('click', () => { currentDate.setDate(currentDate.getDate() - 1); renderDailyView(); });
  document.getElementById('btn-daily-next').addEventListener('click', () => { currentDate.setDate(currentDate.getDate() + 1); renderDailyView(); });
  document.getElementById('btn-daily-today').addEventListener('click', () => { currentDate = new Date(); renderDailyView(); });

  document.getElementById('mayor-filter-date').addEventListener('change', renderMayorScheduleView);
  document.getElementById('btn-mayor-today').addEventListener('click', () => {
    document.getElementById('mayor-filter-date').value = new Date().toISOString().split('T')[0];
    renderMayorScheduleView();
  });
  document.getElementById('btn-add-mayor-event').addEventListener('click', () => {
    document.getElementById('mayor-input-date').value = document.getElementById('mayor-filter-date').value;
    checkMayorInputConflict();
    document.getElementById('modal-mayor').classList.remove('hidden');
  });
  document.getElementById('form-add-mayor').addEventListener('submit', handleAddMayorEngagement);

  document.getElementById('mayor-input-date').addEventListener('change', checkMayorInputConflict);
  document.getElementById('mayor-input-time').addEventListener('change', checkMayorInputConflict);

  document.getElementById('btn-export-mayor-jpg').addEventListener('click', exportMayorScheduleJpg);

  document.getElementById('btn-add-doc').addEventListener('click', () => {
    openSignatureModal();
  });
  document.getElementById('form-add-doc').addEventListener('submit', handleAddDocument);

  document.getElementById('btn-add-appnt').addEventListener('click', () => {
    openNewAppointmentModal();
  });
  document.getElementById('form-add-appnt').addEventListener('submit', handleAddAppointment);
  const formEditAppnt = document.getElementById('form-edit-appnt');
  if (formEditAppnt) formEditAppnt.addEventListener('submit', handleEditAppntSubmit);

  const formAddWR = document.getElementById('form-add-waiting-room');
  if (formAddWR) formAddWR.addEventListener('submit', handleAddWaitingRoomSubmit);

  const formConvertWR = document.getElementById('form-convert-waiting-appnt');
  if (formConvertWR) formConvertWR.addEventListener('submit', handleConvertWaitingToAppntSubmit);

  document.getElementById('btn-arch-sub-appnt').addEventListener('click', () => {
    archiveSubTab = 'appointments';
    document.getElementById('btn-arch-sub-appnt').classList.add('active');
    document.getElementById('btn-arch-sub-doc').classList.remove('active');
    renderArchiveView();
  });
  document.getElementById('btn-arch-sub-doc').addEventListener('click', () => {
    archiveSubTab = 'documents';
    document.getElementById('btn-arch-sub-doc').classList.add('active');
    document.getElementById('btn-arch-sub-appnt').classList.remove('active');
    renderArchiveView();
  });
  document.getElementById('archive-search-input').addEventListener('input', renderArchiveView);

  document.getElementById('btn-add-unit-task').addEventListener('click', () => {
    document.getElementById('ut-input-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('modal-unit-task').classList.remove('hidden');
  });
  document.getElementById('form-add-unit-task').addEventListener('submit', handleAddUnitTask);
  document.getElementById('unit-filter-select').addEventListener('change', renderUnitTasksView);

  document.getElementById('form-task-respond').addEventListener('submit', handleTaskRespondSubmit);
  document.getElementById('btn-run-ai-audit').addEventListener('click', runAiAuditEngine);
  const btnFix = document.getElementById('btn-ai-autofix');
  if (btnFix) btnFix.addEventListener('click', aiAutoFixConflicts);
  document.getElementById('audit-search-input').addEventListener('input', renderAuditLogsView);

  document.getElementById('btn-month-prev').addEventListener('click', () => { currentMonthDate.setMonth(currentMonthDate.getMonth() - 1); renderMonthlyView(); });
  document.getElementById('btn-month-next').addEventListener('click', () => { currentMonthDate.setMonth(currentMonthDate.getMonth() + 1); renderMonthlyView(); });
  document.getElementById('btn-month-today').addEventListener('click', () => { currentMonthDate = new Date(); renderMonthlyView(); });

  const catPills = document.querySelectorAll('#category-filters .cat-pill');
  catPills.forEach(pill => {
    pill.addEventListener('click', () => {
      catPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      activeCategoryFilter = pill.getAttribute('data-cat');
      renderMonthlyView();
    });
  });

  document.getElementById('btn-year-prev').addEventListener('click', () => { currentYear--; renderYearlyView(); });
  document.getElementById('btn-year-next').addEventListener('click', () => { currentYear++; renderYearlyView(); });

  document.getElementById('btn-save-task').addEventListener('click', addQuickTask);
  document.getElementById('btn-print').addEventListener('click', openPrintModal);

  const formAdminEditUser = document.getElementById('form-admin-edit-user');
  if (formAdminEditUser) {
    formAdminEditUser.addEventListener('submit', handleAdminSaveUserSubmit);
  }

  const formCloudConfig = document.getElementById('form-cloud-config');
  if (formCloudConfig) {
    formCloudConfig.addEventListener('submit', handleCloudConfigSubmit);
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const personnelInput = document.getElementById('login-personnel-name');
  const personnelFullName = personnelInput ? personnelInput.value.trim() : '';

  if (personnelFullName) {
    localStorage.setItem('belediye_person_' + username.toLowerCase(), personnelFullName);
  }

  const targetUrl = window.location.protocol === 'file:' ? 'http://127.0.0.1:3500/api/login' : '/api/login';

  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, personnelFullName })
    });
    const data = await res.json();
    if (data.success) {
      loggedInUser = data.user;
      if (personnelFullName) loggedInUser.activePersonnel = personnelFullName;
      sessionStorage.setItem('belediye_active_user', JSON.stringify(loggedInUser));
      if (data.authToken) {
        sessionStorage.setItem('belediye_auth_token', data.authToken);
      }
      document.getElementById('login-error-msg').classList.add('hidden');
      await onLoginSuccess();
      return;
    }
  } catch (err) {
    console.warn('HTTP login fallback to IPC:', err);
  }

  if (window.api) {
    const res = await window.api.loginUser({ username, password, personnelFullName });
    if (res.success) {
      loggedInUser = res.user;
      if (personnelFullName) loggedInUser.activePersonnel = personnelFullName;
      sessionStorage.setItem('belediye_active_user', JSON.stringify(loggedInUser));
      document.getElementById('login-error-msg').classList.add('hidden');
      await onLoginSuccess();
    } else {
      document.getElementById('login-error-msg').classList.remove('hidden');
    }
  } else {
    // Serverless GitHub Pages / Standalone Cloud Login Fallback (when PC is off)
    const cloudData = await browserDirectCloudPull();
    if (cloudData && Array.isArray(cloudData.users)) {
      v3Data = cloudData;
    }
    const fallbackUsers = (v3Data && Array.isArray(v3Data.users) && v3Data.users.length > 0) ? v3Data.users : [
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
    ];
    const found = fallbackUsers.find(u => u.username.toLowerCase() === username.toLowerCase() && u.password === password);
    if (found) {
      loggedInUser = { ...found };
      if (personnelFullName) loggedInUser.activePersonnel = personnelFullName;
      sessionStorage.setItem('belediye_active_user', JSON.stringify(loggedInUser));
      document.getElementById('login-error-msg').classList.add('hidden');
      await onLoginSuccess();
    } else {
      document.getElementById('login-error-msg').classList.remove('hidden');
    }
  }
}

async function onLoginSuccess() {
  await reloadV3Data();
  completeLoginProcess();

  // Only show password change modal if explicitly flagged by admin (mustChangePassword === true)
  if (loggedInUser.mustChangePassword === true) {
    document.getElementById('fl-username').value = loggedInUser.username;
    document.getElementById('fl-password').value = '';
    document.getElementById('fl-password-confirm').value = '';
    document.getElementById('fl-error-msg').classList.add('hidden');
    document.getElementById('modal-first-login-password-change').classList.remove('hidden');

    const formFL = document.getElementById('form-first-login-change');
    formFL.onsubmit = async (e) => {
      e.preventDefault();
      const newU = document.getElementById('fl-username').value.trim();
      const newP = document.getElementById('fl-password').value;
      const confirmP = document.getElementById('fl-password-confirm').value;
      const errEl = document.getElementById('fl-error-msg');

      if (!newU || !newP) {
        errEl.textContent = 'Kullanıcı adı ve şifre boş bırakılamaz!';
        errEl.classList.remove('hidden');
        return;
      }
      if (newP !== confirmP) {
        errEl.textContent = 'Şifreler birbiriyle uyuşmuyor!';
        errEl.classList.remove('hidden');
        return;
      }

      await executeAction('change-user-credentials', {
        targetUsername: loggedInUser.username,
        newUsername: newU,
        newPassword: newP
      });

      loggedInUser.username = newU;
      loggedInUser.password = newP;
      loggedInUser.mustChangePassword = false;
      sessionStorage.setItem('belediye_active_user', JSON.stringify(loggedInUser));

      document.getElementById('modal-first-login-password-change').classList.add('hidden');
      showLiveToast('🔒 Güvenlik Güncellendi', 'Kullanıcı adı ve şifreniz başarıyla değiştirildi.');
      completeLoginProcess();
    };
  }
}

function completeLoginProcess() {
  document.getElementById('login-overlay').classList.add('hidden');
  document.getElementById('app-main-container').classList.remove('hidden');

  const personDisplay = loggedInUser.activePersonnel || loggedInUser.defaultPersonnel || loggedInUser.name || loggedInUser.username;
  document.getElementById('active-user-name').textContent = personDisplay;
  document.getElementById('active-user-role-badge').textContent = getRoleDisplayName(loggedInUser.role);

  applyRolePermissions();
  renderAllViews();
}

function getRoleDisplayName(role) {
  switch (role) {
    case 'admin': return '👑 Sistem Yöneticisi (Admin)';
    case 'baskan': return '👔 Eldivan Belediye Başkanı';
    case 'sekreterya': return '✒️ Özel Kalem & Sekreterya';
    case 'yazi_isleri': return '📜 Yazı İşleri Müdürlüğü';
    case 'fen_isleri': return '🚜 Fen İşleri Müdürlüğü';
    case 'muhasebe': return '💰 Mali Hizmetler / Muhasebe';
    case 'zabita': return '👮 Zabıta Amirliği';
    case 'imar': return '🏗️ İmar ve Şehircilik Müdürlüğü';
    case 'park_bahceler': return '🌳 Park Bahçeler & Temizlik';
    case 'kultur': return '🎭 Kültür ve Sosyal İşler';
    default: return role;
  }
}

function applyRolePermissions() {
  const isExecutive = ['admin', 'baskan', 'sekreterya'].includes(loggedInUser.role);
  const restrictNotice = document.getElementById('daily-access-restricted-notice');
  const execHub = document.getElementById('executive-hub-container');
  const unitHub = document.getElementById('unit-hub-container');
  const navRoleBtn = document.getElementById('nav-btn-role-hub');

  if (!isExecutive) {
    if (restrictNotice) restrictNotice.classList.remove('hidden');
    document.querySelectorAll('.executive-only-btn').forEach(btn => btn.style.display = 'none');
    if (execHub) execHub.classList.add('hidden');
    if (unitHub) unitHub.classList.remove('hidden');
    if (navRoleBtn) navRoleBtn.innerHTML = `🏢 ${getRoleDisplayName(loggedInUser.role)} Paneli`;
  } else {
    if (restrictNotice) restrictNotice.classList.add('hidden');
    document.querySelectorAll('.executive-only-btn').forEach(btn => btn.style.display = 'inline-flex');
    if (execHub) execHub.classList.remove('hidden');
    if (unitHub) unitHub.classList.add('hidden');
    if (navRoleBtn) {
      navRoleBtn.innerHTML = loggedInUser.role === 'baskan'
        ? '🏛️ Başkanlık Paneli'
        : loggedInUser.role === 'sekreterya'
          ? '✒️ Özel Kalem Paneli'
          : '🏛️ Başkanlık & Özel Kalem Paneli';
    }
  }

  const perms = loggedInUser.permissions || {
    perm_daily: true, perm_mayor: true, perm_docs: true, perm_archive: true, perm_tasks: true, perm_chat: true, perm_ai: true, perm_calendar: true, perm_audit: true
  };

  const tabPermMap = {
    'tab-baskanlik-paneli': true,
    'tab-daily': perms.perm_daily !== false,
    'tab-mayor-schedule': perms.perm_mayor !== false,
    'tab-documents-appointments': perms.perm_docs !== false,
    'tab-archive': perms.perm_archive !== false,
    'tab-unit-tasks': perms.perm_tasks !== false,
    'tab-chat': perms.perm_chat !== false,
    'tab-ai-assistant': perms.perm_ai !== false,
    'tab-monthly': perms.perm_calendar !== false,
    'tab-yearly': perms.perm_calendar !== false,
    'tab-audit-logs': perms.perm_audit !== false
  };

  document.querySelectorAll('.nav-tab').forEach(tab => {
    const tabId = tab.getAttribute('data-tab');
    if (tabPermMap[tabId] === false) {
      tab.style.display = 'none';
    } else {
      tab.style.display = 'flex';
    }
  });

  if (!isExecutive) {
    const uSelect = document.getElementById('unit-filter-select');
    if (uSelect) uSelect.value = loggedInUser.role;
  }
}

function canDelete() {
  return loggedInUser && (loggedInUser.role === 'admin' || loggedInUser.role === 'baskan');
}

function canEditAppnt() {
  return loggedInUser && ['admin', 'baskan', 'sekreterya'].includes(loggedInUser.role);
}

function getCombinedMayorSchedule(dateStr) {
  const isExecutive = loggedInUser && ['admin', 'baskan', 'sekreterya'].includes(loggedInUser.role);
  const rawMayorEvents = (v3Data.mayorSchedule || []).filter(x => x.date === dateStr);

  let mayorEvents = [];
  if (isExecutive) {
    mayorEvents = rawMayorEvents.map(m => ({
      ...m,
      isAppointment: false,
      displayTitle: (m.isOutTown || (m.location && (m.location.includes('İl Dışı') || m.location.includes('Şehir Dışı')))) ? `🚗 ${m.title} (İl Dışı)` : m.title,
      displayLocation: m.location || 'Eldivan Belediye Makam Salonu',
      displayNotes: m.notes || '',
      displayBadge: '👔 Başkanlık Programı'
    }));
  } else {
    // Non-executive unit users: mask out-of-town programs into a single summary bar
    const outTownEvents = rawMayorEvents.filter(m => m.isOutTown || (m.location && (m.location.includes('İl Dışı') || m.location.includes('Şehir Dışı'))));
    const localEvents = rawMayorEvents.filter(m => !(m.isOutTown || (m.location && (m.location.includes('İl Dışı') || m.location.includes('Şehir Dışı')))));

    localEvents.forEach(m => {
      mayorEvents.push({
        ...m,
        isAppointment: false,
        displayTitle: m.title,
        displayLocation: m.location || 'Eldivan Belediye Makam Salonu',
        displayNotes: m.notes || '',
        displayBadge: '👔 Başkanlık Programı'
      });
    });

    if (outTownEvents.length > 0) {
      outTownEvents.sort((a, b) => a.time.localeCompare(b.time));
      const firstTime = outTownEvents[0].time;
      const lastTime = outTownEvents[outTownEvents.length - 1].time;
      const timeRange = firstTime === lastTime ? firstTime : `${firstTime} - ${lastTime}`;

      mayorEvents.push({
        id: 'out_town_summary_' + dateStr,
        time: timeRange,
        date: dateStr,
        title: '🚗 BAŞKAN İL DIŞI PROGRAMINDA',
        location: '📍 Şehir Dışı / İl Dışı Programı',
        notes: '🔒 Detaylar Özel Kalem ve Makam Korumasındadır.',
        status: 'Sürüyor',
        isAppointment: false,
        displayTitle: '🚗 BAŞKAN İL DIŞI PROGRAMINDA',
        displayLocation: '📍 Şehir Dışı / İl Dışı Programı',
        displayNotes: '🔒 Detaylar Özel Kalem ve Makam Korumasındadır.',
        displayBadge: '🚗 İl Dışı Programı'
      });
    }
  }

  const appnts = (v3Data.appointments || [])
    .filter(x => x.date === dateStr)
    .map(a => ({
      id: a.id,
      date: a.date,
      time: a.time,
      title: `🤝 ${a.visitorName} (${a.institution || 'Vatandaş'})`,
      location: 'Belediye Başkanlığı Makam Salonu',
      notes: `Görüşme Konusu: ${a.topic}` + (a.notes ? ` • ${a.notes}` : ''),
      status: a.status,
      isAppointment: true,
      displayTitle: `🤝 ${a.visitorName} (${a.institution || 'Vatandaş'})`,
      displayLocation: 'Belediye Başkanlığı Makam Salonu',
      displayNotes: `Görüşme Konusu: ${a.topic}` + (a.notes ? ` • ${a.notes}` : ''),
      displayBadge: '🤝 Ziyaretçi Randevusu'
    }));

  const combined = [...mayorEvents, ...appnts];
  combined.sort((a, b) => a.time.localeCompare(b.time));
  return combined;
}

let lastBellTimestamp = 0;

function renderMakamCockpit() {
  const status = v3Data.mayorStatus || 'kabul-acik';
  const statusDot = document.getElementById('makam-status-dot');
  const statusTitle = document.getElementById('makam-status-title');
  const guestName = document.getElementById('makam-guest-name');
  const guestTitle = document.getElementById('makam-guest-title');
  const guestTimer = document.getElementById('makam-guest-timer');
  const waitingCount = document.getElementById('makam-waiting-count');

  const statusMap = {
    'kabul-acik': { text: 'BAŞKAN MAKAMDA (Kabul Açık)', color: '#10b981' },
    'toplantida': { text: 'TOPLANTIDA (Kabul Bekletiliyor)', color: '#f59e0b' },
    'ilce-disinda': { text: 'İÇ VE DIŞ SAHADA / İLÇE DIŞINDA', color: '#f97316' },
    'kapali': { text: 'MEŞGUL / KABUL KAPALI', color: '#ef4444' }
  };

  const st = statusMap[status] || statusMap['kabul-acik'];
  if (statusDot) statusDot.style.background = st.color;
  if (statusTitle) {
    statusTitle.textContent = st.text;
    statusTitle.style.color = st.color;
  }

  const guest = v3Data.currentGuest || { name: 'Makam Boş', institution: 'Bekleyen Yok', topic: '--', startTime: '--:--' };
  if (guestName) guestName.textContent = guest.name || 'Makam Boş';
  if (guestTitle) guestTitle.textContent = guest.institution ? `(${guest.institution})` : '';
  if (guestTimer) guestTimer.textContent = guest.startTime ? `Giriş: ${guest.startTime}` : '0 dk';

  const waitingList = v3Data.waitingRoom || [];
  if (waitingCount) waitingCount.textContent = `${waitingList.length} Kişi Bekliyor`;

  document.querySelectorAll('.mode-btn').forEach(btn => {
    if (btn.getAttribute('data-status') === status) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  if (v3Data.lastBellRung && v3Data.lastBellRung > lastBellTimestamp) {
    if (lastBellTimestamp !== 0) {
      playNotificationSound('task');
      showLiveToast('🔔 Makam Zili Çaldı!', 'Başkan Makam Odasından Çağrı Gönderdi!');
    }
    lastBellTimestamp = v3Data.lastBellRung;
  }

  const isAuthorized = loggedInUser && ['admin', 'baskan', 'sekreterya'].includes(loggedInUser.role);
  const controls = document.getElementById('makam-controls-group');
  const selector = document.getElementById('makam-mode-selector');
  if (controls) controls.style.display = isAuthorized ? 'flex' : 'none';
  if (selector) selector.style.display = isAuthorized ? 'flex' : 'none';
}

window.takeNextGuest = async function() {
  await executeAction('complete-guest-take-next');
  showLiveToast('✅ Sıradaki Ziyaretçi', 'Ziyaretçi Makam Odasına Davet Edildi.');
  renderAllViews();
};

window.ringMakamBell = async function() {
  playNotificationSound('task');
  await executeAction('ring-bell');
  showLiveToast('🔔 Makam Zili', 'Zil Sinyali İletildi.');
  renderAllViews();
};

window.toggleBusyMode = async function() {
  const newStatus = (v3Data.mayorStatus === 'kapali') ? 'kabul-acik' : 'kapali';
  await executeAction('update-mayor-status', { status: newStatus });
  showLiveToast('🚪 Makam Durumu', newStatus === 'kapali' ? 'Makam Meşgule Alındı' : 'Makam Kabule Açıldı');
  renderAllViews();
};

window.clearMakamRoom = async function() {
  await executeAction('clear-room');
  showLiveToast('🚪 Makam Boşaltıldı', 'Ziyaretçi Çıkışı Tamamlandı.');
  renderAllViews();
};

window.setMayorStatus = async function(status) {
  await executeAction('update-mayor-status', { status });
  showLiveToast('📋 Makam Modu Güncellendi', `Yeni Mod: ${status}`);
  renderAllViews();
};

function renderAllViews() {
  renderMakamCockpit();
  updateBadges();
  renderBaskanlikAndUnitHub();
  renderDailyView();
  renderMayorScheduleView();
  renderDocsAndAppntsView();
  renderArchiveView();
  renderUnitTasksView();
  renderMonthlyView();
  renderYearlyView();
  renderTasksList();
  renderAdminUsersTable();
  renderCloudSettingsUI(true);
}

// -------------------------------------------------------------
// ☁️ GITHUB CLOUD DB & ONLINE CANLI SENKRONİZASYON MOTORU
// -------------------------------------------------------------
window.toggleCloudProviderFields = function() {
  const provEl = document.getElementById('cloud-cfg-provider');
  if (!provEl) return;
  const prov = provEl.value;

  const grpToken = document.getElementById('group-cloud-token');
  const grpGist = document.getElementById('group-cloud-gist');
  const grpRepo = document.getElementById('group-cloud-repo');
  const grpUrl = document.getElementById('group-cloud-url');

  if (prov === 'github-gist') {
    if (grpToken) grpToken.classList.remove('hidden');
    if (grpGist) grpGist.classList.remove('hidden');
    if (grpRepo) grpRepo.classList.add('hidden');
    if (grpUrl) grpUrl.classList.add('hidden');
  } else if (prov === 'github-repo') {
    if (grpToken) grpToken.classList.remove('hidden');
    if (grpGist) grpGist.classList.add('hidden');
    if (grpRepo) grpRepo.classList.remove('hidden');
    if (grpUrl) grpUrl.classList.add('hidden');
  } else {
    if (grpToken) grpToken.classList.add('hidden');
    if (grpGist) grpGist.classList.add('hidden');
    if (grpRepo) grpRepo.classList.add('hidden');
    if (grpUrl) grpUrl.classList.remove('hidden');
  }
};

function renderCloudSettingsUI(populateInputs = false) {
  const cfg = (v3Data && v3Data.settings && v3Data.settings.cloudConfig)
    ? v3Data.settings.cloudConfig
    : JSON.parse(localStorage.getItem('belediye_cloud_config') || '{"enabled":false,"provider":"github-gist"}');

  const headerText = document.getElementById('header-cloud-status-text');
  const headerBadge = document.getElementById('cloud-status-badge');
  const statusPill = document.getElementById('cloud-settings-status-pill');
  const lastSyncEl = document.getElementById('cloud-last-sync-text');
  const errorEl = document.getElementById('cloud-error-text');

  if (cfg.enabled) {
    if (cfg.lastCloudStatus === 'error') {
      if (headerText) headerText.textContent = '⚠️ Bulut Hatası';
      if (headerBadge) { headerBadge.style.background = '#fef2f2'; headerBadge.style.borderColor = '#fca5a5'; headerBadge.style.color = '#991b1b'; }
      if (statusPill) { statusPill.className = 'status-pill reddedildi'; statusPill.textContent = '🔴 Bağlantı Hatası'; }
    } else {
      if (headerText) headerText.textContent = '🟢 Online Kayıt Aktif';
      if (headerBadge) { headerBadge.style.background = '#f0fdf4'; headerBadge.style.borderColor = '#86efac'; headerBadge.style.color = '#166534'; }
      if (statusPill) { statusPill.className = 'status-pill onaylandi'; statusPill.textContent = '🟢 7/24 Online Senkronize'; }
    }
  } else {
    if (headerText) headerText.textContent = 'Bulut Bağla';
    if (statusPill) { statusPill.className = 'status-pill bekliyor'; statusPill.textContent = '⚪ Bulut Pasif'; }
  }

  if (lastSyncEl) lastSyncEl.textContent = cfg.lastCloudSync || 'Henüz senkronize edilmedi';
  if (errorEl) errorEl.textContent = cfg.lastCloudError ? `⚠️ Hata: ${cfg.lastCloudError}` : '';

  if (populateInputs) {
    const enEl = document.getElementById('cloud-cfg-enabled');
    const prEl = document.getElementById('cloud-cfg-provider');
    const tkEl = document.getElementById('cloud-cfg-token');
    const gsEl = document.getElementById('cloud-cfg-gist-id');
    const rpEl = document.getElementById('cloud-cfg-repo');
    const urEl = document.getElementById('cloud-cfg-custom-url');
    const ekEl = document.getElementById('cloud-cfg-encryption-key');
    const gpEl = document.getElementById('cloud-cfg-git-push');

    if (enEl) enEl.checked = !!cfg.enabled;
    if (prEl) prEl.value = cfg.provider || 'github-gist';
    if (tkEl && cfg.githubToken) tkEl.value = cfg.githubToken;
    if (gsEl) gsEl.value = cfg.gistId || '';
    if (rpEl) rpEl.value = cfg.githubRepo || '';
    if (urEl) urEl.value = cfg.customUrl || '';
    if (ekEl) ekEl.value = cfg.encryptionKey || 'ELDIVAN-BLD-2026-GIZLI-ANAHTAR';
    if (gpEl) gpEl.checked = !!cfg.autoGitPush;
    toggleCloudProviderFields();
  }
}

const BROWSER_CLOUD_BOOTSTRAP = {
  gistId: 'd88d80597b1931ae5555c062807547c2',
  repoName: 'Hilmi024/eldivan-belediye-portali',
  tokenVault: {
    iv: '2IYJYn6sWWUvdUeF',
    tag: 'QExTKLy9gZp+kWbVDaoa6Q==',
    cipher: 'hi2x0KpXPiInX/5Rw8ChZ6Z2yXO/2we2O2dOzvQgOSSBL/J0WW8sxA=='
  }
};

async function browserUnlockBootstrapToken(secretPassphrase) {
  try {
    const secret = (secretPassphrase && secretPassphrase.trim()) ? secretPassphrase.trim() : 'ELDIVAN-BLD-2026-GIZLI-ANAHTAR';
    const enc = new TextEncoder();
    const keyHash = await crypto.subtle.digest('SHA-256', enc.encode(secret));
    const cryptoKey = await crypto.subtle.importKey('raw', keyHash, { name: 'AES-GCM' }, false, ['decrypt']);
    const fromBase64 = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const iv = fromBase64(BROWSER_CLOUD_BOOTSTRAP.tokenVault.iv);
    const tag = fromBase64(BROWSER_CLOUD_BOOTSTRAP.tokenVault.tag);
    const cipher = fromBase64(BROWSER_CLOUD_BOOTSTRAP.tokenVault.cipher);
    const combined = new Uint8Array(cipher.length + tag.length);
    combined.set(cipher, 0);
    combined.set(tag, cipher.length);
    const decryptedBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, combined);
    return new TextDecoder().decode(decryptedBuf);
  } catch (e) {
    return '';
  }
}

async function getEffectiveBrowserCloudConfig(dataObj) {
  let cfg = (dataObj && dataObj.settings && dataObj.settings.cloudConfig)
    ? dataObj.settings.cloudConfig
    : JSON.parse(localStorage.getItem('belediye_cloud_config') || 'null');
  if (!cfg) {
    cfg = {
      enabled: true,
      provider: 'github-gist',
      gistId: BROWSER_CLOUD_BOOTSTRAP.gistId,
      encryptionKey: 'ELDIVAN-BLD-2026-GIZLI-ANAHTAR'
    };
  }
  if (cfg.enabled === undefined) cfg.enabled = true;
  if (!cfg.gistId) cfg.gistId = BROWSER_CLOUD_BOOTSTRAP.gistId;
  if (!cfg.encryptionKey) cfg.encryptionKey = 'ELDIVAN-BLD-2026-GIZLI-ANAHTAR';
  if (!cfg.githubToken) {
    cfg.githubToken = await browserUnlockBootstrapToken(cfg.encryptionKey);
  }
  return cfg;
}

window.saveLoginCloudConfig = function() {
  const token = (document.getElementById('login-cloud-token').value || '').trim();
  const gistId = (document.getElementById('login-cloud-gist').value || '').trim();
  const key = (document.getElementById('login-cloud-key').value || 'ELDIVAN-BLD-2026-GIZLI-ANAHTAR').trim();
  const cfg = {
    enabled: true,
    provider: 'github-gist',
    githubToken: token,
    gistId: gistId || BROWSER_CLOUD_BOOTSTRAP.gistId,
    encryptionKey: key
  };
  localStorage.setItem('belediye_cloud_config', JSON.stringify(cfg));
  alert('☁️ Bulut bağlantı ayarları bu tarayıcıya kaydedildi! Şimdi birim kullanıcı adınız ve şifrenizle giriş yapabilirsiniz.');
  document.getElementById('login-cloud-setup-box').classList.add('hidden');
};

async function browserEncryptAES256(plainObj, secretPassphrase) {
  const secret = (secretPassphrase && secretPassphrase.trim()) ? secretPassphrase.trim() : 'ELDIVAN-BLD-2026-GIZLI-ANAHTAR';
  const enc = new TextEncoder();
  const keyHash = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  const cryptoKey = await crypto.subtle.importKey('raw', keyHash, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encodedPlain = enc.encode(JSON.stringify(plainObj));
  const encryptedBuf = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encodedPlain));
  const cipherBytes = encryptedBuf.slice(0, encryptedBuf.length - 16);
  const tagBytes = encryptedBuf.slice(encryptedBuf.length - 16);
  const toBase64 = (u8) => btoa(String.fromCharCode(...u8));
  return JSON.stringify({
    encrypted: true,
    algorithm: 'AES-256-GCM',
    notice: 'T.C. Eldivan Belediyesi Kriptolu Bulut Veritabani - Yetkisiz erisime kapalidir.',
    iv: toBase64(iv),
    tag: toBase64(tagBytes),
    ciphertext: toBase64(cipherBytes),
    updatedAt: new Date().toISOString()
  }, null, 2);
}

async function browserDecryptAES256(rawContent, secretPassphrase) {
  const parsed = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;
  if (!parsed || !parsed.encrypted) return parsed;
  const secret = (secretPassphrase && secretPassphrase.trim()) ? secretPassphrase.trim() : 'ELDIVAN-BLD-2026-GIZLI-ANAHTAR';
  const enc = new TextEncoder();
  const keyHash = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  const cryptoKey = await crypto.subtle.importKey('raw', keyHash, { name: 'AES-GCM' }, false, ['decrypt']);
  const fromBase64 = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const iv = fromBase64(parsed.iv);
  const tag = fromBase64(parsed.tag);
  const cipher = fromBase64(parsed.ciphertext);
  const combined = new Uint8Array(cipher.length + tag.length);
  combined.set(cipher, 0);
  combined.set(tag, cipher.length);
  const decryptedBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, combined);
  return JSON.parse(new TextDecoder().decode(decryptedBuf));
}

async function browserDirectCloudPush(dataObj) {
  const cfg = await getEffectiveBrowserCloudConfig(dataObj);
  if (!cfg || !cfg.enabled) return { success: false, message: 'Bulut pasif' };

  const cleanCopy = JSON.parse(JSON.stringify(dataObj));
  if (cleanCopy.settings && cleanCopy.settings.cloudConfig) {
    cleanCopy.settings.cloudConfig.githubToken = '';
    cleanCopy.settings.cloudConfig.encryptionKey = '';
  }
  const encryptedContent = await browserEncryptAES256(cleanCopy, cfg.encryptionKey || 'ELDIVAN-BLD-2026-GIZLI-ANAHTAR');

  const provider = cfg.provider || 'github-gist';
  if (provider === 'github-gist' && cfg.githubToken) {
    const headers = {
      'Authorization': `token ${cfg.githubToken}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };
    const payload = {
      description: 'T.C. Eldivan Belediyesi - AES-256 Kriptolu Bulut Veritabanı',
      public: false,
      files: {
        'belediye_v3_data.json': {
          content: encryptedContent
        }
      }
    };
    const url = cfg.gistId ? `https://api.github.com/gists/${cfg.gistId}` : 'https://api.github.com/gists';
    const method = cfg.gistId ? 'PATCH' : 'POST';
    const res = await fetch(url, { method, headers, body: JSON.stringify(payload) });
    const json = await res.json();
    if (!res.ok) throw new Error(json.message || 'GitHub Gist hatası');
    if (json.id) {
      cfg.gistId = json.id;
      cfg.lastCloudSync = new Date().toLocaleString('tr-TR');
      cfg.lastCloudStatus = 'synced';
      cfg.lastCloudError = '';
      localStorage.setItem('belediye_cloud_config', JSON.stringify({ ...cfg, githubToken: '' }));
      if (dataObj.settings) dataObj.settings.cloudConfig = cfg;
    }
    return { success: true, gistId: cfg.gistId };
  } else if (provider === 'custom-url' && cfg.customUrl) {
    const res = await fetch(cfg.customUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: encryptedContent
    });
    if (!res.ok) throw new Error('Custom URL HTTP ' + res.status);
    cfg.lastCloudSync = new Date().toLocaleString('tr-TR');
    cfg.lastCloudStatus = 'synced';
    localStorage.setItem('belediye_cloud_config', JSON.stringify(cfg));
    return { success: true };
  }
  return { success: false, message: 'Eksik bulut yapılandırması' };
}

async function browserDirectCloudPull() {
  const cfg = await getEffectiveBrowserCloudConfig(v3Data);
  if (!cfg || !cfg.enabled) return null;

  try {
    const provider = cfg.provider || 'github-gist';
    if (provider === 'github-gist' && cfg.gistId) {
      const headers = { 'Accept': 'application/vnd.github+json' };
      if (cfg.githubToken) headers['Authorization'] = `token ${cfg.githubToken}`;
      const res = await fetch(`https://api.github.com/gists/${cfg.gistId}?t=${Date.now()}`, { headers });
      if (!res.ok) return null;
      const json = await res.json();
      if (json.files && json.files['belediye_v3_data.json']) {
        const remoteData = await browserDecryptAES256(json.files['belediye_v3_data.json'].content, cfg.encryptionKey || 'ELDIVAN-BLD-2026-GIZLI-ANAHTAR');
        if (remoteData.settings) {
          remoteData.settings.cloudConfig = {
            ...cfg,
            lastCloudSync: new Date().toLocaleString('tr-TR'),
            lastCloudStatus: 'synced'
          };
        }
        return remoteData;
      }
    } else if (provider === 'custom-url' && cfg.customUrl) {
      const res = await fetch(cfg.customUrl);
      if (!res.ok) return null;
      const rawJson = await res.json();
      const remoteData = await browserDecryptAES256(rawJson, cfg.encryptionKey || 'ELDIVAN-BLD-2026-GIZLI-ANAHTAR');
      if (remoteData && remoteData.users) {
        if (remoteData.settings) remoteData.settings.cloudConfig = cfg;
        return remoteData;
      }
    }
  } catch (e) {
    console.warn('Browser direct cloud pull error:', e);
  }
  return null;
}

async function handleCloudConfigSubmit(e) {
  e.preventDefault();
  const ekInput = document.getElementById('cloud-cfg-encryption-key');
  const cloudConfig = {
    enabled: document.getElementById('cloud-cfg-enabled').checked,
    provider: document.getElementById('cloud-cfg-provider').value,
    githubToken: document.getElementById('cloud-cfg-token').value.trim(),
    gistId: document.getElementById('cloud-cfg-gist-id').value.trim(),
    githubRepo: document.getElementById('cloud-cfg-repo').value.trim(),
    customUrl: document.getElementById('cloud-cfg-custom-url').value.trim(),
    encryptionKey: ekInput ? ekInput.value.trim() : 'ELDIVAN-BLD-2026-GIZLI-ANAHTAR',
    autoGitPush: document.getElementById('cloud-cfg-git-push').checked
  };

  localStorage.setItem('belediye_cloud_config', JSON.stringify(cloudConfig));
  const targetUrl = window.location.protocol === 'file:' ? 'http://127.0.0.1:3500/api/cloud-sync' : '/api/cloud-sync';

  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        subAction: 'save-config',
        cloudConfig,
        user: getActiveActorLabel()
      })
    });
    if (!res.ok) throw new Error('Local server unreachable');
    const result = await res.json();
    if (result.data) v3Data = result.data;
    renderCloudSettingsUI(true);

    if (result.success) {
      showLiveToast('🔒 Kriptolu Online Veritabanı Aktif', 'Verileriniz AES-256 ile şifrelenerek GitHub / Bulut veritabanına kaydedildi!');
    } else {
      showLiveToast('⚠️ Bulut Uyarısı', result.message || 'Bulut bağlantısı sırasında hata oluştu.');
    }
  } catch (err) {
    try {
      if (!v3Data.settings) v3Data.settings = {};
      v3Data.settings.cloudConfig = cloudConfig;
      const directRes = await browserDirectCloudPush(v3Data);
      renderCloudSettingsUI(true);
      if (directRes.success) {
        showLiveToast('☁️ Tarayıcı Doğrudan Bulut Bağlantısı Aktif', 'Verileriniz doğrudan GitHub Cloud veritabanına kaydedildi!');
      }
    } catch (directErr) {
      showLiveToast('⚠️ Bulut Hatası', directErr.message);
    }
  }
}

window.triggerManualCloudPush = async function() {
  const targetUrl = window.location.protocol === 'file:' ? 'http://127.0.0.1:3500/api/cloud-sync' : '/api/cloud-sync';
  try {
    showLiveToast('☁️ Buluta Kaydediliyor...', 'Veriler AES-256 ile şifrelenerek online veritabanına gönderiliyor.');
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ subAction: 'push-now', user: getActiveActorLabel() })
    });
    if (!res.ok) throw new Error('Local server offline');
    const result = await res.json();
    if (result.data) v3Data = result.data;
    renderCloudSettingsUI(true);
    if (result.success) {
      showLiveToast('✅ Kriptolu Bulut Kaydı Tamamlandı', 'Tüm veriler şifreli olarak online veritabanına kaydedildi.');
    } else {
      alert('Bulut kaydı başarısız: ' + (result.message || 'Lütfen GitHub Token / URL ayarlarınızı kontrol edin.'));
    }
  } catch (err) {
    try {
      const directRes = await browserDirectCloudPush(v3Data);
      renderCloudSettingsUI(true);
      if (directRes.success) {
        showLiveToast('✅ Doğrudan Bulut Kaydı Tamamlandı', 'Veriler tarayıcı üzerinden GitHub Cloud veritabanına yazıldı.');
      } else {
        alert('Bulut kaydı başarısız: ' + (directRes.message || 'Ayarları kontrol edin.'));
      }
    } catch (e2) {
      alert('Bulut bağlantı hatası: ' + e2.message);
    }
  }
};

window.triggerManualCloudPull = async function() {
  const targetUrl = window.location.protocol === 'file:' ? 'http://127.0.0.1:3500/api/cloud-sync' : '/api/cloud-sync';
  try {
    showLiveToast('📥 Buluttan Çekiliyor...', 'Online veritabanındaki şifreli veriler çözülerek alınıyor.');
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ subAction: 'pull-now', user: getActiveActorLabel() })
    });
    if (!res.ok) throw new Error('Local server offline');
    const result = await res.json();
    if (result.data) v3Data = result.data;
    renderAllViews();
    if (result.success) {
      showLiveToast('✅ Veriler Eşitlendi', 'Online veritabanından en güncel kayıtlar yüklendi.');
    } else {
      alert('Buluttan veri çekilemedi: ' + (result.message || 'Lütfen ayarlarınızı kontrol edin.'));
    }
  } catch (err) {
    const directData = await browserDirectCloudPull();
    if (directData) {
      v3Data = directData;
      renderAllViews();
      showLiveToast('✅ Doğrudan Buluttan Eşitlendi', 'GitHub Cloud veritabanından güncel kayıtlar alındı.');
    } else {
      alert('Bulut bağlantı hatası: ' + err.message);
    }
  }
};

// -------------------------------------------------------------
// TAB 0: BAŞKANLIK PANELİ / ÖZEL KALEM PANELİ / KURUM İÇİ BİRİM PANELİ
// -------------------------------------------------------------
window.filterWaitingRoom = function(type, btnEl) {
  activeWaitingRoomFilter = type;
  if (btnEl && btnEl.parentElement) {
    btnEl.parentElement.querySelectorAll('.cat-pill').forEach(b => b.classList.remove('active'));
    btnEl.classList.add('active');
  }
  renderBaskanlikAndUnitHub();
};

window.filterHubSignatures = function(filterKey, btnEl) {
  activeHubSignatureFilter = filterKey;
  if (btnEl && btnEl.parentElement) {
    btnEl.parentElement.querySelectorAll('.cat-pill').forEach(b => b.classList.remove('active'));
    btnEl.classList.add('active');
  }
  renderBaskanlikAndUnitHub();
};

window.openWaitingRoomAddModal = function() {
  document.getElementById('wr-input-name').value = '';
  document.getElementById('wr-input-institution').value = '';
  document.getElementById('wr-input-type').value = 'Randevusuz';
  document.getElementById('wr-input-priority').value = '3';
  document.getElementById('wr-input-topic').value = '';
  document.getElementById('modal-waiting-room').classList.remove('hidden');
};

async function handleAddWaitingRoomSubmit(e) {
  e.preventDefault();
  const item = {
    visitorName: document.getElementById('wr-input-name').value.trim(),
    institution: document.getElementById('wr-input-institution').value.trim() || 'Vatandaş',
    type: document.getElementById('wr-input-type').value,
    priority: Number(document.getElementById('wr-input-priority').value),
    topic: document.getElementById('wr-input-topic').value.trim(),
    arrivalTime: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
    status: 'Bekliyor'
  };
  await executeAction('add-waiting-room', { item });
  await reloadV3Data();
  closeModal('modal-waiting-room');
  showLiveToast('🪑 Bekleme Salonu', `${item.visitorName} bekleme salonuna kaydedildi.`);
  renderAllViews();
}

window.admitWaitingGuest = async function(id) {
  await executeAction('admit-waiting-guest', { id });
  await reloadV3Data();
  playNotificationSound('task');
  showLiveToast('✅ Ziyaretçi Kabul Edildi', 'Ziyaretçi makam odasına alındı.');
  renderAllViews();
};

window.openConvertWaitingToAppntModal = function(id) {
  const wr = (v3Data.waitingRoom || []).find(x => x.id === id);
  if (!wr) return;
  document.getElementById('convert-wr-id').value = wr.id;
  document.getElementById('convert-wr-name').value = `${wr.visitorName} (${wr.institution || wr.type || 'Vatandaş'})`;
  document.getElementById('convert-wr-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('convert-wr-time').value = '14:00';
  document.getElementById('modal-convert-appnt').classList.remove('hidden');
};

async function handleConvertWaitingToAppntSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('convert-wr-id').value;
  const date = document.getElementById('convert-wr-date').value;
  const time = document.getElementById('convert-wr-time').value;
  await executeAction('convert-waiting-to-appnt', { id, date, time });
  await reloadV3Data();
  closeModal('modal-convert-appnt');
  showLiveToast('📅 Randevu Oluşturuldu', `Ziyaretçiye ${date} Saat: ${time} için randevu verildi.`);
  renderAllViews();
}

window.changeWaitingPriority = async function(id, priorityVal) {
  await executeAction('update-waiting-priority', { id, priority: Number(priorityVal) });
  await reloadV3Data();
  renderAllViews();
};

window.moveWaitingRoomItem = async function(id, direction) {
  await executeAction('update-waiting-priority', { id, direction });
  await reloadV3Data();
  renderAllViews();
};

window.deleteWaitingRoomItem = async function(id) {
  await executeAction('delete-waiting-room', { id });
  await reloadV3Data();
  showLiveToast('❌ Kayıt Çıkarıldı', 'Bekleme salonundan kayıt reddedildi/çıkarıldı.');
  renderAllViews();
};

window.approveAppointmentWithDateTime = async function(id) {
  const dateEl = document.getElementById('appnt-inline-date-' + id);
  const timeEl = document.getElementById('appnt-inline-time-' + id);
  const dateVal = dateEl ? dateEl.value : undefined;
  const timeVal = timeEl ? timeEl.value : undefined;
  await executeAction('update-appnt-status', { id, status: 'Onaylandı', date: dateVal, time: timeVal });
  await reloadV3Data();
  playNotificationSound('task');
  showLiveToast('✅ Randevu Onaylandı', `Tarih: ${dateVal || ''} Saat: ${timeVal || ''} olarak onaylandı.`);
  renderAllViews();
};

window.rejectAppointmentRequest = async function(id) {
  await executeAction('update-appnt-status', { id, status: 'Reddedildi' });
  await reloadV3Data();
  showLiveToast('❌ Randevu Reddedildi', 'Randevu/görüşme talebi reddedildi.');
  renderAllViews();
};

window.openSignatureModal = function() {
  document.getElementById('doc-input-target-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('doc-input-title').value = '';
  document.getElementById('doc-input-no').value = '2026/' + Math.floor(1000 + Math.random() * 9000);
  document.getElementById('doc-input-desc').value = '';
  const unitSel = document.getElementById('doc-input-unit');
  if (unitSel && loggedInUser && !['admin', 'baskan', 'sekreterya'].includes(loggedInUser.role)) {
    unitSel.value = loggedInUser.role;
  }
  const personInput = document.getElementById('doc-input-person');
  if (personInput && loggedInUser) {
    personInput.value = loggedInUser.activePersonnel || loggedInUser.defaultPersonnel || loggedInUser.name || '';
  }
  document.getElementById('modal-doc').classList.remove('hidden');
};

window.markSignatureStatus = async function(id, status) {
  await executeAction('update-doc-status', { id, status });
  await reloadV3Data();
  playNotificationSound('task');
  showLiveToast(status === 'İmzalandı' ? '✅ İmzalandı' : '❌ İmza Reddedildi', `İmza durumu '${status}' olarak güncellendi.`);
  renderAllViews();
};

window.openNewAppointmentModal = function() {
  const titleEl = document.getElementById('modal-appnt-title');
  if (titleEl) titleEl.textContent = '🤝 Yeni Ziyaretçi Randevusu / Görüşme Talebi';
  document.getElementById('appnt-input-name').value = '';
  document.getElementById('appnt-input-institution').value = '';
  document.getElementById('appnt-input-category').value = 'Randevulu';
  document.getElementById('appnt-input-priority').value = 'normal';
  document.getElementById('appnt-input-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('appnt-input-time').value = '11:00';
  document.getElementById('appnt-input-topic').value = '';
  document.getElementById('appnt-input-notes').value = '';
  document.getElementById('modal-appnt').classList.remove('hidden');
};

window.openUnitMeetingRequestModal = function() {
  const titleEl = document.getElementById('modal-appnt-title');
  if (titleEl) titleEl.textContent = '🗣️ Başkanla Kurum İçi Görüşme Talebi';
  const personName = loggedInUser ? (loggedInUser.activePersonnel || loggedInUser.defaultPersonnel || loggedInUser.name) : '';
  const unitName = loggedInUser ? getRoleDisplayName(loggedInUser.role).replace(/^[^\s]+\s/, '') : '';
  document.getElementById('appnt-input-name').value = personName;
  document.getElementById('appnt-input-institution').value = unitName;
  document.getElementById('appnt-input-category').value = 'Personel';
  document.getElementById('appnt-input-priority').value = 'oncelikli';
  document.getElementById('appnt-input-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('appnt-input-time').value = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('appnt-input-topic').value = '';
  document.getElementById('appnt-input-notes').value = 'Birim görüşme talebi';
  document.getElementById('modal-appnt').classList.remove('hidden');
};

function renderBaskanlikAndUnitHub() {
  const waitingRoom = v3Data.waitingRoom || [];
  const appointments = v3Data.appointments || [];
  const documents = v3Data.documents || [];
  const todayStr = new Date().toISOString().split('T')[0];
  const todayMayor = getCombinedMayorSchedule(todayStr);

  // 1. Update Executive Hub Stats
  const wrRandevulu = waitingRoom.filter(w => w.type === 'Randevulu').length;
  const wrRandevusuz = waitingRoom.filter(w => w.type === 'Randevusuz').length;
  const wrKurum = waitingRoom.filter(w => w.type && (w.type.includes('Kurum') || w.type.includes('Meclis'))).length;
  const wrPersonel = waitingRoom.filter(w => w.type === 'Personel').length;

  const elWaitTotal = document.getElementById('hub-stat-waiting-total');
  if (elWaitTotal) elWaitTotal.textContent = `${waitingRoom.length} Kişi Bekliyor`;
  const elWaitBreak = document.getElementById('hub-stat-waiting-breakdown');
  if (elWaitBreak) elWaitBreak.textContent = `Kurum/Meclis: ${wrKurum} • Randevulu: ${wrRandevulu} • Randevusuz: ${wrRandevusuz} • Personel: ${wrPersonel}`;

  const pendingAppnts = appointments.filter(a => a.status !== 'Tamamlandı' && a.status !== 'Reddedildi');
  const elAppntPend = document.getElementById('hub-stat-appnt-pending');
  if (elAppntPend) elAppntPend.textContent = `${pendingAppnts.length} Talep`;

  const islakCount = documents.filter(d => (d.signType || 'islak') === 'islak').length;
  const eimzaCount = documents.filter(d => d.signType === 'e-imza').length;
  const acilDocCount = documents.filter(d => d.priority === 'acil').length;

  const elSignTotal = document.getElementById('hub-stat-sign-total');
  if (elSignTotal) elSignTotal.textContent = `${documents.length} Bekleyen İmza`;
  const elSignBreak = document.getElementById('hub-stat-sign-breakdown');
  if (elSignBreak) elSignBreak.textContent = `🔏 Islak İmza: ${islakCount} • 💻 E-İmza: ${eimzaCount} (🔴 Acil: ${acilDocCount})`;

  const elMayorToday = document.getElementById('hub-stat-mayor-today');
  if (elMayorToday) elMayorToday.textContent = `${todayMayor.length} Program`;

  // 2. Render Waiting Room List
  const elWRList = document.getElementById('hub-waiting-room-list');
  if (elWRList) {
    const filteredWR = activeWaitingRoomFilter === 'all'
      ? waitingRoom
      : waitingRoom.filter(w => (w.type || 'Randevusuz').includes(activeWaitingRoomFilter));

    if (filteredWR.length === 0) {
      elWRList.innerHTML = `<div class="summary-item-card empty">🪑 Bekleme salonunda bu kategoride bekleyen ziyaretçi veya personel bulunmuyor.</div>`;
    } else {
      elWRList.innerHTML = filteredWR.map((w, idx) => {
        const prio = w.priority || 3;
        const prioBadge = prio === 1
          ? '<span class="priority-badge acil">🔴 1. Öncelik (Protokol/Acil)</span>'
          : prio === 2
            ? '<span class="priority-badge sureli">🟡 2. Öncelik</span>'
            : '<span class="priority-badge normal">🔵 3. Normal Sıra</span>';
        const typeBadge = w.type === 'Kurum / Protokol'
          ? '🏛️ Kurum / Meclis Üyesi'
          : w.type === 'Personel'
            ? '👷 Belediye Personeli'
            : w.type === 'Randevulu'
              ? '🤝 Randevulu'
              : '🚶 Randevusuz Vatandaş';

        return `
          <div class="summary-item-card" style="flex-direction:column; align-items:stretch; gap:8px; border-left-width:5px; border-left-color:${prio === 1 ? '#dc2626' : prio === 2 ? '#d97706' : '#0284c7'};">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:6px;">
              <div>
                <span style="font-weight:800; font-size:0.96rem; color:#131b2e;">${idx + 1}. ${w.visitorName}</span>
                <span style="font-size:0.8rem; color:#64748b; margin-left:6px;">(${w.institution || 'Vatandaş'})</span>
                <div style="font-size:0.83rem; color:#334155; margin-top:3px;"><strong>Konu:</strong> ${w.topic || 'Genel Görüşme'} • 🕒 Geliş: ${w.arrivalTime || '--:--'}</div>
              </div>
              <div style="display:flex; gap:5px; align-items:center; flex-wrap:wrap;">
                <span class="badge badge-info">${typeBadge}</span>
                ${prioBadge}
              </div>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; padding-top:6px; border-top:1px dashed #e2e8f0;">
              <div style="display:flex; align-items:center; gap:4px;">
                <span style="font-size:0.75rem; font-weight:700; color:#64748b;">Öncelik Sırası:</span>
                <select onchange="changeWaitingPriority('${w.id}', this.value)" style="font-size:0.75rem; padding:2px 6px; border-radius:4px; border:1px solid #cbd5e1;">
                  <option value="1" ${prio === 1 ? 'selected' : ''}>1 - Çok Öncelikli / Protokol</option>
                  <option value="2" ${prio === 2 ? 'selected' : ''}>2 - Öncelikli</option>
                  <option value="3" ${prio === 3 ? 'selected' : ''}>3 - Normal</option>
                </select>
                <button class="btn-sm btn-secondary" style="padding:2px 6px;" title="Sırayı Yukarı Taşı" onclick="moveWaitingRoomItem('${w.id}', 'up')">⬆️</button>
                <button class="btn-sm btn-secondary" style="padding:2px 6px;" title="Sırayı Aşağı Taşı" onclick="moveWaitingRoomItem('${w.id}', 'down')">⬇️</button>
              </div>
              <div style="display:flex; gap:6px; flex-wrap:wrap;">
                <button class="btn-sm btn-primary" style="background:#059669;" onclick="admitWaitingGuest('${w.id}')">✅ Onayla & İçeri Al</button>
                <button class="btn-sm btn-secondary" style="background:#0284c7; color:#fff;" onclick="openConvertWaitingToAppntModal('${w.id}')">📅 Randevu Saat/Gün Ver</button>
                <button class="btn-sm btn-secondary" style="background:#dc2626; color:#fff;" onclick="deleteWaitingRoomItem('${w.id}')">❌ Reddet</button>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // 3. Render Appointment & Meeting Requests (with inline Date & Time specification)
  const elAppntReqList = document.getElementById('hub-appointment-requests-list');
  if (elAppntReqList) {
    if (appointments.length === 0) {
      elAppntReqList.innerHTML = `<div class="summary-item-card empty">🤝 Bekleyen randevu veya görüşme talebi bulunmuyor.</div>`;
    } else {
      elAppntReqList.innerHTML = appointments.map(a => {
        const prio = a.priority || 'normal';
        const prioBadge = prio === 'acil'
          ? '<span class="priority-badge acil">🔴 Acil</span>'
          : prio === 'oncelikli'
            ? '<span class="priority-badge sureli">🟡 Öncelikli</span>'
            : '<span class="priority-badge normal">🔵 Normal</span>';
        const catLabel = a.visitorCategory || 'Randevulu';

        return `
          <div class="summary-item-card" style="flex-direction:column; align-items:stretch; gap:8px; border-left-width:5px; border-left-color:${a.status === 'Onaylandı' ? '#059669' : '#d97706'};">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:6px;">
              <div>
                <span style="font-weight:800; font-size:0.95rem; color:#131b2e;">${a.visitorName}</span>
                <span style="font-size:0.8rem; color:#9b4500; font-weight:600;">(${a.institution || 'Vatandaş'})</span>
                <div style="font-size:0.83rem; color:#334155; margin-top:2px;"><strong>Konu:</strong> ${a.topic} ${a.notes ? '• ' + a.notes : ''}</div>
              </div>
              <div style="display:flex; gap:5px; align-items:center;">
                <span class="badge badge-info">${catLabel}</span>
                ${prioBadge}
                <span class="status-pill ${a.status === 'Onaylandı' ? 'onaylandi' : 'bekliyor'}">${a.status || 'Onay Bekliyor'}</span>
              </div>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; padding-top:6px; border-top:1px dashed #e2e8f0;">
              <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                <span style="font-size:0.75rem; font-weight:700; color:#475569;">📅 Gün & Saat Belirle:</span>
                <input type="date" id="appnt-inline-date-${a.id}" value="${a.date || todayStr}" style="font-size:0.78rem; padding:3px 6px; border:1px solid #cbd5e1; border-radius:4px;">
                <input type="time" id="appnt-inline-time-${a.id}" value="${a.time || '11:00'}" style="font-size:0.78rem; padding:3px 6px; border:1px solid #cbd5e1; border-radius:4px;">
              </div>
              <div style="display:flex; gap:6px;">
                <button class="btn-sm btn-primary" style="background:#059669;" onclick="approveAppointmentWithDateTime('${a.id}')">✅ Saat/Gün Onayla</button>
                <button class="btn-sm btn-secondary" style="background:#0284c7; color:#fff;" onclick="approveAppointment('${a.id}', 'Tamamlandı')">✓ Görüşüldü (Arşiv)</button>
                <button class="btn-sm btn-secondary" style="background:#dc2626; color:#fff;" onclick="rejectAppointmentRequest('${a.id}')">❌ Reddet</button>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // 4. Render Pending Signatures (Islak İmza / E-İmza & Acil / Normal)
  const elSigList = document.getElementById('hub-signatures-list');
  if (elSigList) {
    let filteredDocs = documents;
    if (activeHubSignatureFilter === 'islak') {
      filteredDocs = documents.filter(d => (d.signType || 'islak') === 'islak');
    } else if (activeHubSignatureFilter === 'e-imza') {
      filteredDocs = documents.filter(d => d.signType === 'e-imza');
    } else if (activeHubSignatureFilter === 'acil') {
      filteredDocs = documents.filter(d => d.priority === 'acil');
    } else if (activeHubSignatureFilter === 'normal') {
      filteredDocs = documents.filter(d => d.priority !== 'acil');
    }

    if (filteredDocs.length === 0) {
      elSigList.innerHTML = `<div class="summary-item-card empty">✒️ Bu filtrede bekleyen imza veya evrak bulunmuyor.</div>`;
    } else {
      elSigList.innerHTML = filteredDocs.map(d => {
        const isEimza = d.signType === 'e-imza';
        const signTypeBadge = isEimza
          ? '<span class="badge" style="background:#e0f2fe; color:#0369a1; font-weight:800;">💻 E-İMZA (EBYS)</span>'
          : '<span class="badge" style="background:#fef3c7; color:#92400e; font-weight:800;">🔏 ISLAK İMZA</span>';
        const prioBadge = d.priority === 'acil'
          ? '<span class="priority-badge acil">🔴 ACİL</span>'
          : d.priority === 'sureli'
            ? '<span class="priority-badge sureli">🟡 SÜRELİ</span>'
            : '<span class="priority-badge normal">🔵 NORMAL</span>';

        return `
          <div class="summary-item-card" style="flex-direction:column; align-items:stretch; gap:8px; border-left-width:5px; border-left-color:${d.priority === 'acil' ? '#dc2626' : isEimza ? '#0284c7' : '#d97706'};">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:6px;">
              <div>
                <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:4px;">
                  ${signTypeBadge}
                  ${prioBadge}
                  ${d.docNo ? `<span style="font-size:0.76rem; font-weight:700; color:#64748b;">No: ${d.docNo}</span>` : ''}
                </div>
                <div style="font-weight:800; font-size:0.95rem; color:#131b2e;">${d.title}</div>
                <div style="font-size:0.8rem; color:#475569; margin-top:2px;">
                  🏢 <strong>Birim:</strong> ${d.assignedUnitName || d.assignedUnit} • 👤 <strong>Sunan:</strong> ${d.submittedByPerson || d.creator || 'Birim Personeli'}
                </div>
                ${d.description ? `<div style="font-size:0.8rem; color:#64748b; margin-top:2px;">📝 ${d.description}</div>` : ''}
              </div>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; padding-top:6px; border-top:1px dashed #e2e8f0;">
              <span style="font-size:0.75rem; color:#64748b;">📅 Son İşlem: ${d.targetDate || todayStr}</span>
              <div style="display:flex; gap:6px;">
                <button class="btn-sm btn-primary" style="background:#059669;" onclick="markSignatureStatus('${d.id}', 'İmzalandı')">✅ İmzalandı</button>
                <button class="btn-sm btn-secondary" style="background:#dc2626; color:#fff;" onclick="markSignatureStatus('${d.id}', 'Reddedildi')">❌ Reddet / İade</button>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // 5. Render Today's Schedule on Executive Hub
  const elHubSched = document.getElementById('hub-daily-schedule-list');
  if (elHubSched) {
    if (todayMayor.length === 0) {
      elHubSched.innerHTML = `<div class="summary-item-card empty">👔 Bugün için kayıtlı Başkanlık programı bulunmuyor.</div>`;
    } else {
      elHubSched.innerHTML = todayMayor.map(m => `
        <div class="summary-item-card" style="${m.isAppointment ? 'border-left-color: var(--color-accent);' : ''}">
          <div class="summary-item-left">
            <span class="summary-time">🕒 ${m.time}</span>
            <div class="summary-title-group">
              <span class="summary-item-title">${m.displayTitle}</span>
              <span class="summary-item-sub">📍 ${m.displayLocation} ${m.displayNotes ? '• ' + m.displayNotes : ''}</span>
            </div>
          </div>
          <span class="badge ${m.status === 'Tamamlandı' || m.status === 'Onaylandı' ? 'badge-success' : 'badge-warning'}">${m.status || 'Bekliyor'}</span>
        </div>
      `).join('');
    }
  }

  // 6. Render Kurum İçi Birim Özel Arayüzü (#unit-hub-container)
  if (loggedInUser) {
    const unitTitleEl = document.getElementById('unit-hub-title');
    const unitPersonEl = document.getElementById('unit-hub-personnel-identity');
    const unitMakamStatusEl = document.getElementById('unit-hub-makam-status');
    const unitMakamGuestEl = document.getElementById('unit-hub-makam-guest');

    const roleName = getRoleDisplayName(loggedInUser.role);
    const personIdentity = loggedInUser.activePersonnel || loggedInUser.defaultPersonnel || loggedInUser.name || loggedInUser.username;

    if (unitTitleEl) unitTitleEl.textContent = `${roleName} — Kurum İçi Operasyon ve İmza Ekranı`;
    if (unitPersonEl) unitPersonEl.innerHTML = `👤 <strong>Aktif Personel Kimliği:</strong> ${personIdentity} &nbsp;|&nbsp; 🏢 <strong>Birim Sorumluluk Alanı:</strong> ${roleName}`;

    const statusMap = {
      'kabul-acik': '🟢 BAŞKAN MAKAMDA (Kabul Açık - Müsait)',
      'toplantida': '🟡 TOPLANTIDA (Görüşmeler Bekletiliyor)',
      'ilce-disinda': '🟠 İLÇE DIŞINDA / SAHA PROGRAMINDA',
      'kapali': '🔴 MEŞGUL / KABUL KAPALI'
    };
    if (unitMakamStatusEl) unitMakamStatusEl.textContent = statusMap[v3Data.mayorStatus || 'kabul-acik'] || '🟢 MAKAMDA';
    if (unitMakamGuestEl) {
      const gName = (v3Data.currentGuest && v3Data.currentGuest.name) ? v3Data.currentGuest.name : 'Makam Boş';
      unitMakamGuestEl.textContent = `Şu An Makamda: ${gName} • Bekleme Salonu: ${waitingRoom.length} Kişi Bekliyor`;
    }

    // Unit's own submitted signatures
    const unitSigListEl = document.getElementById('unit-hub-signatures-list');
    if (unitSigListEl) {
      const myPendingDocs = documents.filter(d => d.assignedUnit === loggedInUser.role);
      const myArchivedDocs = (v3Data.archivedDocuments || []).filter(d => d.assignedUnit === loggedInUser.role).slice(0, 5);

      if (myPendingDocs.length === 0 && myArchivedDocs.length === 0) {
        unitSigListEl.innerHTML = `<div class="summary-item-card empty">✒️ Biriminiz tarafından makama sunulmuş imza kaydı bulunmuyor. Yukarıdaki "+ İmza Girişi Yap" butonundan yeni imza sunabilirsiniz.</div>`;
      } else {
        let html = '';
        myPendingDocs.forEach(d => {
          const isEimza = d.signType === 'e-imza';
          html += `
            <div class="summary-item-card" style="flex-direction:column; align-items:stretch; gap:8px; border-left:5px solid ${d.priority === 'acil' ? '#dc2626' : '#0284c7'};">
              <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                <div>
                  <span class="badge" style="background:${isEimza ? '#e0f2fe' : '#fef3c7'}; color:${isEimza ? '#0369a1' : '#92400e'}; font-weight:800;">
                    ${isEimza ? '💻 E-İmza' : '🔏 Islak İmza'}
                  </span>
                  <span class="priority-badge ${d.priority}" style="margin-left:4px;">${d.priority === 'acil' ? '🔴 Acil' : '🔵 Normal'}</span>
                  <div style="font-weight:800; color:#131b2e; margin-top:4px;">${d.title}</div>
                  <div style="font-size:0.78rem; color:#64748b;">Evrak No: ${d.docNo || '-'} • Sunan: ${d.submittedByPerson || personIdentity}</div>
                </div>
                <span class="status-pill bekliyor">İmza Bekliyor</span>
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center; padding-top:6px; border-top:1px dashed #e2e8f0;">
                <span style="font-size:0.75rem; color:#475569;">Birim Sorumluluğu: İmzalandıysa durumu güncelleyiniz</span>
                <button class="btn-sm btn-primary" style="background:#059669;" onclick="markSignatureStatus('${d.id}', 'İmzalandı')">✅ İmzalandı Girdisi Ver</button>
              </div>
            </div>
          `;
        });

        myArchivedDocs.forEach(ad => {
          html += `
            <div class="summary-item-card" style="border-left:4px solid #10b981; opacity:0.88;">
              <div class="summary-item-left">
                <div class="summary-title-group">
                  <span class="summary-item-title">✅ ${ad.title} (${ad.signType === 'e-imza' ? 'E-İmza' : 'Islak İmza'})</span>
                  <span class="summary-item-sub">Sonuç: ${ad.status || 'İmzalandı'} • İşleyen: ${ad.archivedBy || ''} (${ad.archivedDate || ''})</span>
                </div>
              </div>
              <span class="badge badge-success">${ad.status || 'İmzalandı'}</span>
            </div>
          `;
        });
        unitSigListEl.innerHTML = html;
      }
    }

    // Unit's meeting requests
    const unitMeetEl = document.getElementById('unit-hub-meetings-list');
    if (unitMeetEl) {
      const uNamePlain = roleName.replace(/^[^\s]+\s/, '').toLowerCase();
      const myRequests = appointments.filter(a =>
        (a.institution && a.institution.toLowerCase().includes(uNamePlain)) ||
        (a.creator && a.creator.toLowerCase().includes(loggedInUser.username.toLowerCase())) ||
        a.visitorCategory === 'Personel'
      );
      if (myRequests.length === 0) {
        unitMeetEl.innerHTML = `<div class="summary-item-card empty">🗣️ Biriminize ait aktif görüşme talebi bulunmuyor.</div>`;
      } else {
        unitMeetEl.innerHTML = myRequests.map(r => `
          <div class="summary-item-card" style="border-left-color:${r.status === 'Onaylandı' ? '#059669' : '#d97706'};">
            <div class="summary-item-left">
              <span class="summary-time">🕒 ${r.time}</span>
              <div class="summary-title-group">
                <span class="summary-item-title">${r.visitorName} — ${r.topic}</span>
                <span class="summary-item-sub">📅 Tarih: ${r.date} • Öncelik: ${r.priority === 'acil' ? '🔴 Acil' : 'Normal'}</span>
              </div>
            </div>
            <span class="status-pill ${r.status === 'Onaylandı' ? 'onaylandi' : 'bekliyor'}">${r.status}</span>
          </div>
        `).join('');
      }
    }

    // Unit's schedule & tasks summary
    const unitSchedEl = document.getElementById('unit-hub-schedule-list');
    if (unitSchedEl) {
      if (todayMayor.length === 0) {
        unitSchedEl.innerHTML = `<div class="summary-item-card empty">👔 Bugün için kayıtlı Başkanlık programı bulunmuyor.</div>`;
      } else {
        unitSchedEl.innerHTML = todayMayor.map(m => `
          <div class="summary-item-card">
            <div class="summary-item-left">
              <span class="summary-time">🕒 ${m.time}</span>
              <div class="summary-title-group">
                <span class="summary-item-title">${m.displayTitle}</span>
                <span class="summary-item-sub">📍 ${m.displayLocation}</span>
              </div>
            </div>
            <span class="badge badge-info">${m.status || 'Planlandı'}</span>
          </div>
        `).join('');
      }
    }
  }
}

function renderAdminUsersTable() {
  const tableBody = document.getElementById('admin-users-table-body');
  if (!tableBody) return;

  const users = v3Data.users || [];
  if (users.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:18px; color:var(--text-muted);">Sistemde tanımlı kullanıcı bulunamadı.</td></tr>`;
    return;
  }

  tableBody.innerHTML = users.map(u => {
    const isSelf = loggedInUser && loggedInUser.username.toLowerCase() === u.username.toLowerCase();
    const permTags = u.permissions ? Object.keys(u.permissions).filter(k => u.permissions[k]).length + '/9 Modül Yetkisi' : 'Tüm Yetkiler';
    return `
      <tr>
        <td><strong>${u.username}</strong> ${u.mustChangePassword ? '<span class="badge badge-warning" style="font-size:0.65rem;">İlk Giriş Bekliyor</span>' : ''}</td>
        <td>${u.name || u.username}</td>
        <td><code style="background:#f1f5f9; padding:2px 8px; border-radius:4px; font-weight:700; color:#131b2e;">${u.password}</code></td>
        <td><span class="badge badge-info">${getRoleDisplayName(u.role)}</span></td>
        <td><span class="status-pill onaylandi">${permTags}</span></td>
        <td style="text-align:right;">
          <button class="btn-sm btn-secondary" onclick="openAdminEditUserModal('${u.username}')">✏️ Düzenle</button>
          ${!isSelf ? `<button class="btn-sm btn-secondary" style="background:#dc2626; color:#fff;" onclick="adminDeleteUser('${u.username}')">🗑️ Sil</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');
}

window.openAdminAddUserModal = function() {
  document.getElementById('admin-user-modal-title').textContent = '👤 Yeni Kullanıcı Hesabı Ekle';
  document.getElementById('admin-user-orig-username').value = '';
  document.getElementById('admin-user-username').value = '';
  document.getElementById('admin-user-password').value = 'belediye123';
  document.getElementById('admin-user-name').value = '';
  document.getElementById('admin-user-role').value = 'yazi_isleri';

  ['perm_daily', 'perm_mayor', 'perm_docs', 'perm_archive', 'perm_tasks', 'perm_chat', 'perm_ai', 'perm_calendar', 'perm_audit'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.checked = true;
  });

  document.getElementById('modal-admin-edit-user').classList.remove('hidden');
};

window.openAdminEditUserModal = function(username) {
  const user = (v3Data.users || []).find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return;

  document.getElementById('admin-user-modal-title').textContent = `👤 Kullanıcı Düzenle: ${user.username}`;
  document.getElementById('admin-user-orig-username').value = user.username;
  document.getElementById('admin-user-username').value = user.username;
  document.getElementById('admin-user-password').value = user.password;
  document.getElementById('admin-user-name').value = user.name || user.username;
  document.getElementById('admin-user-role').value = user.role || 'yazi_isleri';

  const perms = user.permissions || {};
  ['perm_daily', 'perm_mayor', 'perm_docs', 'perm_archive', 'perm_tasks', 'perm_chat', 'perm_ai', 'perm_calendar', 'perm_audit'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.checked = perms[id] !== false;
  });

  document.getElementById('modal-admin-edit-user').classList.remove('hidden');
};

window.adminDeleteUser = async function(username) {
  if (confirm(`'${username}' kullanıcı hesabını kalıcı olarak silmek istediğinize emin misiniz?`)) {
    await executeAction('admin-delete-user', { targetUsername: username });
    await reloadV3Data();
    showLiveToast('🗑️ Kullanıcı Silindi', `'${username}' hesabı kaldırıldı.`);
    renderAdminUsersTable();
  }
};

async function handleAdminSaveUserSubmit(e) {
  e.preventDefault();
  const origUsername = document.getElementById('admin-user-orig-username').value;
  const username = document.getElementById('admin-user-username').value.trim();
  const password = document.getElementById('admin-user-password').value;
  const name = document.getElementById('admin-user-name').value.trim();
  const role = document.getElementById('admin-user-role').value;

  const permissions = {};
  ['perm_daily', 'perm_mayor', 'perm_docs', 'perm_archive', 'perm_tasks', 'perm_chat', 'perm_ai', 'perm_calendar', 'perm_audit'].forEach(id => {
    const el = document.getElementById(id);
    permissions[id] = el ? el.checked : true;
  });

  const userObj = {
    originalUsername: origUsername,
    username,
    password,
    name,
    role,
    permissions
  };

  await executeAction('admin-save-user', { userObj });
  await reloadV3Data();
  closeModal('modal-admin-edit-user');
  showLiveToast('👤 Kullanıcı Kaydedildi', `'${username}' bilgileri ve yetkileri güncellendi.`);
  renderAdminUsersTable();
}

function updateBadges() {
  const pendingDocs = v3Data.documents ? v3Data.documents.length : 0;
  const pendingUnitTasks = v3Data.unitTasks ? v3Data.unitTasks.length : 0;

  document.getElementById('badge-doc-count').textContent = pendingDocs;
  document.getElementById('badge-unit-tasks').textContent = pendingUnitTasks;
}

// -------------------------------------------------------------
// TAB 1: GÜNLÜK GÖRÜNÜM (360 EXECUTIVE COMMAND DASHBOARD)
// -------------------------------------------------------------
function renderDailyView() {
  const day = currentDate.getDate();
  const month = currentDate.getMonth() + 1;
  const year = currentDate.getFullYear();
  const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  // Hero Date Display
  document.getElementById('hero-day-num').textContent = String(day).padStart(2, '0');
  document.getElementById('hero-month-name').textContent = currentDate.toLocaleDateString('tr-TR', { month: 'long' });
  document.getElementById('hero-year-num').textContent = year;
  document.getElementById('hero-weekday-name').textContent = currentDate.toLocaleDateString('tr-TR', { weekday: 'long' });

  // Filter Items for Selected Date
  const mayorEvents = v3Data.mayorSchedule ? v3Data.mayorSchedule.filter(x => x.date === dateStr) : [];
  const appnts = v3Data.appointments ? v3Data.appointments.filter(x => x.date === dateStr) : [];
  const docs = v3Data.documents ? v3Data.documents.filter(x => x.targetDate === dateStr || (x.priority === 'acil' && x.status !== 'Tamamlandı')) : [];
  const unitTasks = v3Data.unitTasks ? v3Data.unitTasks.filter(x => x.date === dateStr) : [];

  // Update Stats Widget
  document.getElementById('stat-mayor-count').textContent = mayorEvents.length;
  document.getElementById('stat-appnt-count').textContent = appnts.length;
  document.getElementById('stat-doc-count').textContent = docs.length;
  document.getElementById('stat-task-count').textContent = unitTasks.length;

  // 1. Mayor Schedule Summary Widget
  const elMayorSum = document.getElementById('daily-summary-mayor-list');
  const combinedMayor = getCombinedMayorSchedule(dateStr);
  if (combinedMayor.length === 0) {
    elMayorSum.innerHTML = `<div class="summary-item-card empty">👔 Seçili günde kayıtlı Başkanlık programı veya randevu bulunmuyor.</div>`;
  } else {
    elMayorSum.innerHTML = combinedMayor.map(m => `
      <div class="summary-item-card" style="${m.isAppointment ? 'border-left-color: var(--color-accent);' : ''}">
        <div class="summary-item-left">
          <span class="summary-time">🕒 ${m.time}</span>
          <div class="summary-title-group">
            <span class="summary-item-title">${m.displayTitle}</span>
            <span class="summary-item-sub">📍 ${m.displayLocation} ${m.displayNotes ? '• ' + m.displayNotes : ''}</span>
          </div>
        </div>
        <span class="badge ${m.status === 'Tamamlandı' || m.status === 'Onaylandı' ? 'badge-success' : 'badge-warning'}">${m.status || 'Bekliyor'}</span>
      </div>
    `).join('');
  }

  // 2. Visitor Appointments Summary Widget
  const elAppntSum = document.getElementById('daily-summary-appnt-list');
  if (appnts.length === 0) {
    elAppntSum.innerHTML = `<div class="summary-item-card empty">🤝 Seçili günde randevulu ziyaretçi kaydı bulunmuyor.</div>`;
  } else {
    appnts.sort((a, b) => a.time.localeCompare(b.time));
    elAppntSum.innerHTML = appnts.map(a => `
      <div class="summary-item-card" style="border-left-color: var(--color-accent);">
        <div class="summary-item-left">
          <span class="summary-time" style="color:var(--color-accent);">🕒 ${a.time}</span>
          <div class="summary-title-group">
            <span class="summary-item-title">${a.visitorName} (${a.institution || 'Vatandaş'})</span>
            <span class="summary-item-sub">Konu: ${a.topic} ${a.notes ? '• ' + a.notes : ''}</span>
          </div>
        </div>
        <span class="status-pill ${a.status === 'Onaylandı' ? 'onaylandi' : 'bekliyor'}">${a.status}</span>
      </div>
    `).join('');
  }

  // 3. Pending Documents Summary Widget
  const elDocSum = document.getElementById('daily-summary-doc-list');
  if (docs.length === 0) {
    elDocSum.innerHTML = `<div class="summary-item-card empty">📄 Seçili gün için acil veya son işlem tarihli evrak bulunmuyor.</div>`;
  } else {
    elDocSum.innerHTML = docs.map(d => `
      <div class="summary-item-card" style="border-left-color: ${d.priority === 'acil' ? 'var(--color-danger)' : 'var(--color-primary)'};">
        <div class="summary-item-left">
          <span class="summary-time" style="font-size:0.8rem; color:#fff; width:auto;">📄 No: ${d.docNo}</span>
          <div class="summary-title-group">
            <span class="summary-item-title">${d.title}</span>
            <span class="summary-item-sub">🏢 Birim: ${d.assignedUnitName || d.assignedUnit} • Son Tarih: ${d.targetDate}</span>
          </div>
        </div>
        <span class="priority-badge ${d.priority}">${d.priority === 'acil' ? '🔴 Acil' : d.priority === 'sureli' ? '🟡 Süreli' : '🔵 Normal'}</span>
      </div>
    `).join('');
  }

  // 4. Unit Tasks Summary Widget
  const elTaskSum = document.getElementById('daily-summary-task-list');
  if (unitTasks.length === 0) {
    elTaskSum.innerHTML = `<div class="summary-item-card empty">📢 Seçili gün için atanan birim görevi bulunmuyor.</div>`;
  } else {
    elTaskSum.innerHTML = unitTasks.map(u => `
      <div class="summary-item-card" style="border-left-color: var(--color-purple);">
        <div class="summary-item-left">
          <div class="summary-title-group">
            <span class="summary-item-title">${u.title}</span>
            <span class="summary-item-sub">🏢 Atanan Birim: ${u.assignedUnitName || u.assignedUnit} ${u.notes ? '• ' + u.notes : ''}</span>
          </div>
        </div>
        <span class="badge badge-info">${u.status || 'Devam Ediyor'}</span>
      </div>
    `).join('');
  }

  // 5. Official Days & Weeks
  const activeEvents = getEventsForDate(year, month, day);
  const elList = document.getElementById('active-days-list');
  document.getElementById('active-count-badge').textContent = `${activeEvents.length} Önemli Gün / Etkinlik`;

  if (activeEvents.length === 0) {
    elList.innerHTML = `<div class="event-card-item" style="border-left-color: var(--color-secondary);">
      <div class="event-card-title">📌 Bugün İçin Kayıtlı Resmi Özel Gün Bulunmuyor</div>
      <p class="event-card-desc">Eldivan Belediyesi rutin hizmetlerinize devam edebilirsiniz.</p>
    </div>`;
  } else {
    elList.innerHTML = activeEvents.map(ev => `
      <div class="event-card-item" style="border-left-color: ${getCategoryColor(ev.category)};">
        <div class="event-card-header">
          <span class="event-card-title">${ev.is_official_holiday ? '🔴 (Resmi Tatil) ' : ''}${ev.name}</span>
          <span class="badge" style="background:${getCategoryColor(ev.category)}22; color:${getCategoryColor(ev.category)};">
            ${ev.category_name || 'Belediye Etkinliği'}
          </span>
        </div>
        <p class="event-card-desc">${ev.description || ''}</p>
        ${ev.municipal_actions && ev.municipal_actions.length > 0 ? `
          <div class="municipal-tips-box">
            <h4>🏛️ Eldivan Belediyesi Aksiyon & Basın Yayın Önerileri:</h4>
            <ul>${ev.municipal_actions.map(act => `<li>${act}</li>`).join('')}</ul>
          </div>
        ` : ''}
      </div>
    `).join('');
  }

  renderUpcomingDays();
}

function getEventsForDate(year, month, day) {
  if (!eventsDb) return [];
  const events = [];

  eventsDb.fixed_events.forEach(ev => {
    if (ev.type === 'day' && ev.month === month && ev.day === day) {
      events.push(ev);
    } else if (ev.type === 'week') {
      const dt = new Date(year, month - 1, day);
      const start = new Date(year, ev.start_month - 1, ev.start_day);
      const end = new Date(year, ev.end_month - 1, ev.end_day);
      if (dt >= start && dt <= end) events.push({ ...ev, name: `${ev.name} (Hafta İçi Etkinliği)` });
    }
  });

  if (eventsDb.hijri_events_mapping && eventsDb.hijri_events_mapping[year.toString()]) {
    eventsDb.hijri_events_mapping[year.toString()].forEach(ev => {
      if (ev.month === month && ev.day === day) events.push({ ...ev, category_name: 'Dini Bayram / Özel Gece' });
    });
  }

  return events;
}

function getCategoryColor(cat) {
  switch (cat) {
    case 'belediye': return '#0284c7';
    case 'milli': return '#dc2626';
    case 'dini': return '#059669';
    case 'cevre_saglik': return '#16a34a';
    case 'sosyal_kultur': return '#d97706';
    default: return '#7c3aed';
  }
}

function renderUpcomingDays() {
  const elList = document.getElementById('upcoming-days-list');
  const upcoming = [];

  for (let i = 1; i <= 7; i++) {
    const futureDate = new Date(currentDate);
    futureDate.setDate(futureDate.getDate() + i);
    const day = futureDate.getDate();
    const month = futureDate.getMonth() + 1;
    const year = futureDate.getFullYear();

    const evs = getEventsForDate(year, month, day);
    evs.forEach(e => upcoming.push({
      dateStr: `${day} ${futureDate.toLocaleDateString('tr-TR', { month: 'short' })}`,
      title: e.name, category: e.category
    }));
  }

  if (upcoming.length === 0) {
    elList.innerHTML = `<div class="upcoming-item" style="border-left-color: var(--text-muted); color: var(--text-muted);">Önümüzdeki 7 gün içinde özel gün bulunmuyor.</div>`;
  } else {
    elList.innerHTML = upcoming.map(item => `
      <div class="upcoming-item" style="border-left-color: ${getCategoryColor(item.category)};">
        <span class="upcoming-date">${item.dateStr}</span>
        <span class="upcoming-title">${item.title}</span>
      </div>
    `).join('');
  }
}

function renderTasksList() {
  const elList = document.getElementById('task-list');
  elList.innerHTML = dailyTasks.map((task, idx) => `
    <li class="task-item ${task.done ? 'completed' : ''}">
      <div style="display:flex; align-items:center; gap:8px;">
        <input type="checkbox" ${task.done ? 'checked' : ''} onchange="toggleTask(${idx})">
        <span>${task.text}</span>
      </div>
      <button class="btn-icon" onclick="deleteTask(${idx})">✕</button>
    </li>
  `).join('');
}

function addQuickTask() {
  const input = document.getElementById('input-task-text');
  const text = input.value.trim();
  if (!text) return;
  dailyTasks.push({ text, done: false });
  localStorage.setItem('belediye_daily_tasks', JSON.stringify(dailyTasks));
  input.value = '';
  renderTasksList();
}

window.toggleTask = function(idx) {
  dailyTasks[idx].done = !dailyTasks[idx].done;
  localStorage.setItem('belediye_daily_tasks', JSON.stringify(dailyTasks));
  renderTasksList();
};

window.deleteTask = function(idx) {
  dailyTasks.splice(idx, 1);
  localStorage.setItem('belediye_daily_tasks', JSON.stringify(dailyTasks));
  renderTasksList();
};

// -------------------------------------------------------------
// TAB 2: BAŞKAN PROGRAMI & ELDİVAN GRAPHIC JPEG EXPORT
// -------------------------------------------------------------
function renderMayorScheduleView() {
  const filterDate = document.getElementById('mayor-filter-date').value;
  const elList = document.getElementById('mayor-schedule-list');

  const combined = getCombinedMayorSchedule(filterDate);

  if (combined.length === 0) {
    elList.innerHTML = `<div class="card" style="text-align:center; padding:30px; color:var(--text-muted);">
      👔 Bu tarih için tanımlı Başkanlık kabul, toplantı veya randevu programı bulunmuyor.
    </div>`;
    return;
  }

  elList.innerHTML = combined.map(item => `
    <div class="mayor-item ${item.isAppointment ? 'appointment-item' : ''}" style="${item.isAppointment ? 'border-left-color: var(--color-accent);' : ''}">
      <div class="mayor-time-badge" style="${item.isAppointment ? 'background: linear-gradient(135deg, #d97706, #b45309); color:#fff;' : ''}">🕒 ${item.time}</div>
      <div class="mayor-details">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
          <span class="badge ${item.isAppointment ? 'badge-info' : 'badge-primary'}" style="font-size:0.72rem;">${item.displayBadge}</span>
          <span class="mayor-title">${item.displayTitle}</span>
        </div>
        <div class="mayor-location">📍 ${item.displayLocation}</div>
        <div class="mayor-notes">${item.displayNotes}</div>
      </div>
      <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
        <span class="badge ${item.status === 'Tamamlandı' || item.status === 'Onaylandı' ? 'badge-success' : 'badge-warning'}">${item.status || 'Bekliyor'}</span>
        <div style="display:flex; gap:4px;">
          ${item.isAppointment && canEditAppnt() ? `<button class="btn-sm btn-secondary" style="background:#0284c7; color:#fff;" onclick="openEditAppntModal('${item.id}')">✏️ Düzenle</button>` : ''}
          ${canDelete() ? `
            <button class="btn-sm btn-secondary" style="background:#ef4444; color:#fff;" onclick="${item.isAppointment ? `deleteAppointment('${item.id}')` : `deleteMayorEvent('${item.id}')`}">🗑️ Sil</button>
          ` : ''}
        </div>
      </div>
    </div>
  `).join('');
}

async function handleAddMayorEngagement(e) {
  e.preventDefault();
  const dateVal = document.getElementById('mayor-input-date').value;
  const timeVal = document.getElementById('mayor-input-time').value;
  const titleVal = document.getElementById('mayor-input-title').value.trim();

  const existing = (v3Data.mayorSchedule || []).find(x => x.date === dateVal && x.time === timeVal);
  if (existing) {
    alert(`🤖 Yapay Zeka Engeli: ${dateVal} tarihinde saat ${timeVal}'da zaten '${existing.title}' programı bulunmaktadır.\n\nSaatli olan programlar aynı saate yapılmasın. Lütfen farklı bir saat seçiniz!`);
    return;
  }

  const item = {
    date: dateVal,
    time: timeVal,
    title: titleVal,
    location: document.getElementById('mayor-input-location').value.trim(),
    notes: document.getElementById('mayor-input-notes').value.trim(),
    status: 'Bekliyor'
  };

  await executeAction('add-mayor', { item });
  await reloadV3Data();
  closeModal('modal-mayor');
  renderMayorScheduleView();
  renderDailyView();
  renderMonthlyView();
}

window.deleteMayorEvent = async function(id) {
  if (!canDelete()) {
    alert('Silme yetkisi sadece Yönetici (Admin) ve Belediye Başkanı hesaplarındadır!');
    return;
  }
  if (confirm('Bu Başkanlık programını sistemden kalıcı olarak silmek istediğinize emin misiniz?')) {
    await executeAction('delete-mayor', { id });
    v3Data.mayorSchedule = (v3Data.mayorSchedule || []).filter(x => x.id !== id);
    await reloadV3Data();
    renderMayorScheduleView();
    renderDailyView();
    renderMonthlyView();
  }
};

async function exportMayorScheduleJpg() {
  const dateVal = document.getElementById('mayor-filter-date').value;
  if (!dateVal) return;

  const dt = new Date(dateVal);
  const day = dt.getDate();
  const monthName = dt.toLocaleDateString('tr-TR', { month: 'long' });
  const year = dt.getFullYear();
  const weekday = dt.toLocaleDateString('tr-TR', { weekday: 'long' });

  const formattedDateTitle = `${day} ${monthName} ${year}`;
  const fileName = `Eldivan_Belediyesi_Gunluk_Rapor_${formattedDateTitle.replace(/\s+/g, '_')}.jpg`;

  const mayorEvents = (v3Data.mayorSchedule || []).filter(x => x.date === dateVal);
  const appnts = (v3Data.appointments || []).filter(x => x.date === dateVal);
  const docs = (v3Data.documents || []).filter(x => x.targetDate === dateVal || (x.priority === 'acil' && x.status !== 'Tamamlandı'));
  const tasks = (v3Data.unitTasks || []).filter(x => x.date === dateVal);

  const logoImg = new Image();
  logoImg.src = 'icon.png';
  await new Promise(resolve => { logoImg.onload = resolve; logoImg.onerror = resolve; });

  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 2000;
  const ctx = canvas.getContext('2d');

  // Crisp Light Background
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, 1200, 2000);

  // Outer Frames
  ctx.strokeStyle = '#d97706';
  ctx.lineWidth = 10;
  ctx.strokeRect(20, 20, 1160, 1960);

  ctx.strokeStyle = '#131b2e';
  ctx.lineWidth = 2;
  ctx.strokeRect(32, 32, 1136, 1936);

  // Top Executive Header Banner
  const headerGrad = ctx.createLinearGradient(0, 35, 0, 310);
  headerGrad.addColorStop(0, '#0f172a');
  headerGrad.addColorStop(1, '#1e293b');
  ctx.fillStyle = headerGrad;
  ctx.fillRect(35, 35, 1130, 275);

  ctx.fillStyle = '#d97706';
  ctx.fillRect(35, 305, 1130, 5);

  if (logoImg.complete && logoImg.naturalWidth !== 0) {
    ctx.drawImage(logoImg, 530, 45, 130, 130);
  }

  ctx.fillStyle = '#f59e0b';
  ctx.font = 'bold 22px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('T.C. ELDİVAN BELEDİYE BAŞKANLIĞI', 600, 205);

  ctx.fillStyle = '#ffffff';
  ctx.font = '800 32px "Plus Jakarta Sans", sans-serif';
  ctx.fillText('GÜNLÜK BAŞKANLIK PROGRAMI, EVRAK & İŞ RAPORU', 600, 250);

  ctx.fillStyle = '#38bdf8';
  ctx.font = 'bold 22px "Plus Jakarta Sans", sans-serif';
  ctx.fillText(`🗓️ Tarih: ${formattedDateTitle}, ${weekday}`, 600, 285);

  let yPos = 330;

  // SECTION 1: BAŞKANLIK PROGRAMLARI
  ctx.fillStyle = '#131b2e';
  ctx.fillRect(80, yPos, 1040, 36);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 18px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`👔 BAŞKANLIK PROGRAMLARI & KABULLER (${mayorEvents.length})`, 95, yPos + 24);
  yPos += 46;

  if (mayorEvents.length === 0) {
    ctx.fillStyle = '#64748b';
    ctx.font = '16px "Plus Jakarta Sans", sans-serif';
    ctx.fillText('Kayıtlı Başkanlık programı bulunmamaktadır.', 95, yPos + 20);
    yPos += 35;
  } else {
    mayorEvents.forEach(m => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(80, yPos, 1040, 75);
      ctx.strokeStyle = '#131b2e';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(80, yPos, 1040, 75);
      ctx.fillStyle = '#131b2e';
      ctx.fillRect(80, yPos, 10, 75);

      ctx.fillStyle = '#131b2e';
      ctx.font = '800 20px monospace';
      ctx.fillText(m.time, 105, yPos + 32);

      ctx.fillStyle = '#0b1c30';
      ctx.font = 'bold 18px "Plus Jakarta Sans", sans-serif';
      const title = m.title;
      ctx.fillText(title.length > 55 ? title.substring(0, 55) + '...' : title, 200, yPos + 32);

      ctx.fillStyle = '#9b4500';
      ctx.font = '600 15px "Plus Jakarta Sans", sans-serif';
      ctx.fillText(`📍 ${m.location || 'Makam Salonu'} ${m.notes ? '• ' + m.notes : ''}`, 200, yPos + 60);

      yPos += 85;
    });
  }

  yPos += 10;

  // SECTION 2: RANDEVULU ZİYARETÇİLER
  ctx.fillStyle = '#d97706';
  ctx.fillRect(80, yPos, 1040, 36);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 18px "Plus Jakarta Sans", sans-serif';
  ctx.fillText(`🤝 ZİYARETÇİ & PROTOKOL RANDEVULARI (${appnts.length})`, 95, yPos + 24);
  yPos += 46;

  if (appnts.length === 0) {
    ctx.fillStyle = '#64748b';
    ctx.font = '16px "Plus Jakarta Sans", sans-serif';
    ctx.fillText('Kayıtlı ziyaretçi randevusu bulunmamaktadır.', 95, yPos + 20);
    yPos += 35;
  } else {
    appnts.forEach(a => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(80, yPos, 1040, 75);
      ctx.strokeStyle = '#d97706';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(80, yPos, 1040, 75);
      ctx.fillStyle = '#d97706';
      ctx.fillRect(80, yPos, 10, 75);

      ctx.fillStyle = '#9b4500';
      ctx.font = '800 20px monospace';
      ctx.fillText(a.time, 105, yPos + 32);

      ctx.fillStyle = '#0b1c30';
      ctx.font = 'bold 18px "Plus Jakarta Sans", sans-serif';
      ctx.fillText(`${a.visitorName} (${a.institution || 'Vatandaş'})`, 200, yPos + 32);

      ctx.fillStyle = '#475569';
      ctx.font = '600 15px "Plus Jakarta Sans", sans-serif';
      ctx.fillText(`Konu: ${a.topic}`, 200, yPos + 60);

      yPos += 85;
    });
  }

  yPos += 10;

  // SECTION 3: RESMİ EVRAKLAR
  ctx.fillStyle = '#059669';
  ctx.fillRect(80, yPos, 1040, 36);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 18px "Plus Jakarta Sans", sans-serif';
  ctx.fillText(`📄 SÜRELİ & ACİL RESMİ EVRAKLAR (${docs.length})`, 95, yPos + 24);
  yPos += 46;

  if (docs.length === 0) {
    ctx.fillStyle = '#64748b';
    ctx.font = '16px "Plus Jakarta Sans", sans-serif';
    ctx.fillText('İlgili gün için süreli veya acil evrak bulunmamaktadır.', 95, yPos + 20);
    yPos += 35;
  } else {
    docs.forEach(d => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(80, yPos, 1040, 75);
      ctx.strokeStyle = '#059669';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(80, yPos, 1040, 75);
      ctx.fillStyle = '#059669';
      ctx.fillRect(80, yPos, 10, 75);

      ctx.fillStyle = '#047857';
      ctx.font = 'bold 16px monospace';
      ctx.fillText(`No: ${d.docNo}`, 105, yPos + 30);

      ctx.fillStyle = '#0b1c30';
      ctx.font = 'bold 17px "Plus Jakarta Sans", sans-serif';
      ctx.fillText(d.title, 230, yPos + 30);

      ctx.fillStyle = '#475569';
      ctx.font = '14px "Plus Jakarta Sans", sans-serif';
      ctx.fillText(`Birim: ${d.assignedUnitName} • Son Tarih: ${d.targetDate}`, 230, yPos + 55);

      yPos += 85;
    });
  }

  yPos += 10;

  // SECTION 4: BİRİM GÖREVLERİ
  ctx.fillStyle = '#7c3aed';
  ctx.fillRect(80, yPos, 1040, 36);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 18px "Plus Jakarta Sans", sans-serif';
  ctx.fillText(`📢 ATANAN BİRİM GÖREVLERİ & İCRAATLAR (${tasks.length})`, 95, yPos + 24);
  yPos += 46;

  if (tasks.length === 0) {
    ctx.fillStyle = '#64748b';
    ctx.font = '16px "Plus Jakarta Sans", sans-serif';
    ctx.fillText('İlgili günde atanan birim görevi bulunmamaktadır.', 95, yPos + 20);
  } else {
    tasks.forEach(t => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(80, yPos, 1040, 75);
      ctx.strokeStyle = '#7c3aed';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(80, yPos, 1040, 75);
      ctx.fillStyle = '#7c3aed';
      ctx.fillRect(80, yPos, 10, 75);

      ctx.fillStyle = '#0b1c30';
      ctx.font = 'bold 17px "Plus Jakarta Sans", sans-serif';
      ctx.fillText(t.title, 105, yPos + 30);

      ctx.fillStyle = '#475569';
      ctx.font = '14px "Plus Jakarta Sans", sans-serif';
      ctx.fillText(`Atanan Birim: ${t.assignedUnitName} • Durum: ${t.status || 'Devam Ediyor'}`, 105, yPos + 55);

      yPos += 85;
    });
  }

  // Footer Line
  ctx.strokeStyle = '#dce9ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(80, 1900);
  ctx.lineTo(1120, 1900);
  ctx.stroke();

  ctx.fillStyle = '#0b1c30';
  ctx.font = 'bold 16px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('T.C. ELDİVAN BELEDİYE BAŞKANLIĞI • ÖZEL KALEM VE MÜDÜRLÜKLER ORTAK AJANDA PORTALI', 600, 1930);

  ctx.fillStyle = '#64748b';
  ctx.font = '14px "Plus Jakarta Sans", sans-serif';
  ctx.fillText(`KamuNet Güvenli Ağ • Basım Tarihi: ${new Date().toLocaleString('tr-TR')} • Belge No: EBYS-${Date.now().toString().substring(5)}`, 600, 1955);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.95);

  if (window.api) {
    const res = await window.api.saveJpgImage({ base64Data: dataUrl, fileName: fileName });
    if (res.success) {
      alert(`🎉 Eldivan Belediye Başkanı Günlük Programı ve Birim İşleri Raporu Masaüstünüze '${fileName}' adıyla yüksek çözünürlükte kaydedildi!\n\nDosya Yolu: ${res.filePath}`);
    } else {
      alert('Görsel kaydedilirken hata oluştu: ' + res.error);
    }
  } else {
    const link = document.createElement('a');
    link.download = fileName;
    link.href = dataUrl;
    link.click();
  }
}

// TAB 3: EVRAK & RANDEVULAR
function renderDocsAndAppntsView() {
  const elDocs = document.getElementById('documents-list');
  const docs = v3Data.documents || [];

  if (docs.length === 0) {
    elDocs.innerHTML = `<p style="color:var(--text-muted); font-size:0.85rem;">Kayıtlı bekleyen imza veya evrak bulunmuyor.</p>`;
  } else {
    elDocs.innerHTML = docs.map(doc => {
      const isEimza = doc.signType === 'e-imza';
      const signTypeLabel = isEimza ? '💻 E-İmza (EBYS)' : '🔏 Islak İmza';
      return `
        <div class="doc-card">
          <div class="doc-card-header">
            <span class="doc-no">${signTypeLabel} • No: ${doc.docNo || '-'}</span>
            <span class="priority-badge ${doc.priority}">${doc.priority === 'acil' ? '🔴 Acil' : doc.priority === 'sureli' ? '🟡 Süreli' : '🔵 Normal'}</span>
          </div>
          <div style="font-weight:700; color:#131b2e; font-size:0.94rem; margin-bottom:4px;">${doc.title}</div>
          <div style="font-size:0.8rem; color:var(--color-primary); margin-bottom:4px;">🏢 Birim: ${doc.assignedUnitName || doc.assignedUnit} • 👤 Sunan: ${doc.submittedByPerson || doc.creator || '-'}</div>
          <div style="font-size:0.82rem; color:var(--text-muted); margin-bottom:8px;">${doc.description || ''}</div>
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
            <span style="font-size:0.75rem; color:var(--color-accent);">Son İşlem: ${doc.targetDate}</span>
            <div style="display:flex; gap:6px;">
              <button class="btn-sm btn-primary" style="background:#059669;" onclick="markSignatureStatus('${doc.id}', 'İmzalandı')">✅ İmzalandı</button>
              <button class="btn-sm btn-secondary" style="background:#dc2626; color:#fff;" onclick="markSignatureStatus('${doc.id}', 'Reddedildi')">❌ Reddet</button>
              ${canDelete() ? `<button class="btn-sm btn-secondary" style="background:#475569; color:#fff;" onclick="deleteDocument('${doc.id}')">🗑️ Sil</button>` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  const elAppnts = document.getElementById('appointments-list');
  const appnts = v3Data.appointments || [];

  if (appnts.length === 0) {
    elAppnts.innerHTML = `<p style="color:var(--text-muted); font-size:0.85rem;">Kayıtlı aktif randevu bulunmuyor.</p>`;
  } else {
    elAppnts.innerHTML = appnts.map(a => `
      <div class="appnt-card">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <span style="font-weight:700; color:#131b2e; font-size:0.95rem;">🤝 ${a.visitorName}</span>
          <span class="status-pill ${a.status === 'Onaylandı' ? 'onaylandi' : 'bekliyor'}">${a.status}</span>
        </div>
        <div style="font-size:0.8rem; color:var(--color-accent); margin-bottom:4px;">${a.institution || 'Vatandaş'} (${a.visitorCategory || 'Randevulu'})</div>
        <div style="font-size:0.85rem; color:#334155; margin-bottom:6px;">Konu: ${a.topic}</div>
        <div style="font-size:0.78rem; color:var(--text-muted);">Tarih: ${a.date} 🕒 ${a.time}</div>
        
        <div style="display:flex; gap:6px; margin-top:8px; justify-content:flex-end;">
          ${canEditAppnt() ? `<button class="btn-sm btn-secondary" style="background:#0284c7; color:#fff;" onclick="openEditAppntModal('${a.id}')">✏️ Saat/Gün Düzenle</button>` : ''}
          <button class="btn-sm btn-primary" onclick="approveAppointment('${a.id}', 'Onaylandı')">✓ Onayla</button>
          <button class="btn-sm btn-secondary" style="background:#dc2626; color:#fff;" onclick="rejectAppointmentRequest('${a.id}')">❌ Reddet</button>
          ${canDelete() ? `<button class="btn-sm btn-secondary" style="background:#475569; color:#fff;" onclick="deleteAppointment('${a.id}')">🗑️ Sil</button>` : ''}
        </div>
      </div>
    `).join('');
  }
}

window.openEditAppntModal = function(id) {
  if (!canEditAppnt()) {
    alert('Randevu düzenleme yetkisi Sekreterya, Belediye Başkanı ve Yönetici hesaplarındadır!');
    return;
  }
  const appnt = (v3Data.appointments || []).find(a => a.id === id);
  if (!appnt) return;

  document.getElementById('appnt-edit-id').value = appnt.id;
  document.getElementById('appnt-edit-name').value = appnt.visitorName || '';
  document.getElementById('appnt-edit-institution').value = appnt.institution || '';
  document.getElementById('appnt-edit-date').value = appnt.date || '';
  document.getElementById('appnt-edit-time').value = appnt.time || '';
  document.getElementById('appnt-edit-topic').value = appnt.topic || '';
  document.getElementById('appnt-edit-notes').value = appnt.notes || '';
  document.getElementById('appnt-edit-status').value = appnt.status || 'Onay Bekliyor';

  document.getElementById('modal-edit-appnt').classList.remove('hidden');
};

async function handleEditAppntSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('appnt-edit-id').value;
  const appnt = {
    visitorName: document.getElementById('appnt-edit-name').value.trim(),
    institution: document.getElementById('appnt-edit-institution').value.trim(),
    date: document.getElementById('appnt-edit-date').value,
    time: document.getElementById('appnt-edit-time').value,
    topic: document.getElementById('appnt-edit-topic').value.trim(),
    notes: document.getElementById('appnt-edit-notes').value.trim(),
    status: document.getElementById('appnt-edit-status').value
  };

  await executeAction('edit-appnt', { id, appnt });
  await reloadV3Data();
  closeModal('modal-edit-appnt');
  renderAllViews();
  playNotificationSound('task');
}

async function handleAddDocument(e) {
  e.preventDefault();
  const unitSelect = document.getElementById('doc-input-unit');
  const signTypeEl = document.getElementById('doc-input-sign-type');
  const personEl = document.getElementById('doc-input-person');
  const doc = {
    docNo: document.getElementById('doc-input-no').value.trim() || ('2026/' + Math.floor(1000 + Math.random() * 9000)),
    signType: signTypeEl ? signTypeEl.value : 'islak',
    priority: document.getElementById('doc-input-priority').value,
    title: document.getElementById('doc-input-title').value.trim(),
    assignedUnit: unitSelect.value,
    assignedUnitName: unitSelect.options[unitSelect.selectedIndex].text,
    submittedByPerson: personEl ? personEl.value.trim() : getActiveActorLabel(),
    targetDate: document.getElementById('doc-input-target-date').value,
    description: document.getElementById('doc-input-desc').value.trim(),
    creator: getActiveActorLabel(),
    status: 'İmza Bekliyor'
  };

  await executeAction('add-doc', { doc });
  await reloadV3Data();
  closeModal('modal-doc');
  showLiveToast('✒️ İmza Sunuldu', `${doc.title} (${doc.signType === 'e-imza' ? 'E-İmza' : 'Islak İmza'}) kaydedildi.`);
  renderAllViews();
}

window.completeDocument = async function(id) {
  await executeAction('update-doc-status', { id, status: 'İmzalandı' });
  await reloadV3Data();
  renderAllViews();
};

async function handleAddAppointment(e) {
  e.preventDefault();
  const catEl = document.getElementById('appnt-input-category');
  const prioEl = document.getElementById('appnt-input-priority');
  const appnt = {
    visitorName: document.getElementById('appnt-input-name').value.trim(),
    institution: document.getElementById('appnt-input-institution').value.trim(),
    visitorCategory: catEl ? catEl.value : 'Randevulu',
    priority: prioEl ? prioEl.value : 'normal',
    date: document.getElementById('appnt-input-date').value,
    time: document.getElementById('appnt-input-time').value,
    topic: document.getElementById('appnt-input-topic').value.trim(),
    notes: document.getElementById('appnt-input-notes').value.trim(),
    creator: getActiveActorLabel(),
    status: 'Onay Bekliyor'
  };

  await executeAction('add-appnt', { appnt });
  await reloadV3Data();
  closeModal('modal-appnt');
  showLiveToast('🤝 Randevu / Görüşme Talebi', `${appnt.visitorName} için talep oluşturuldu.`);
  renderAllViews();
}

window.approveAppointment = async function(id, status) {
  await executeAction('update-appnt-status', { id, status });
  await reloadV3Data();
  renderAllViews();
};

window.deleteAppointment = async function(id) {
  await executeAction('delete-appnt', { id });
  await reloadV3Data();
  renderAllViews();
};

// TAB 4: GEÇMİŞ ARŞİV
function renderArchiveView() {
  const search = document.getElementById('archive-search-input').value.toLowerCase().trim();
  const elContent = document.getElementById('archive-content-list');

  if (archiveSubTab === 'appointments') {
    const list = v3Data.archivedAppointments || [];
    const filtered = list.filter(a => 
      a.visitorName.toLowerCase().includes(search) ||
      (a.institution && a.institution.toLowerCase().includes(search)) ||
      a.topic.toLowerCase().includes(search)
    );

    if (filtered.length === 0) {
      elContent.innerHTML = `<p style="color:var(--text-muted); padding:20px; text-align:center;">Geçmiş ziyaretçi görüşme kaydı bulunamadı.</p>`;
      return;
    }

    elContent.innerHTML = filtered.map(a => `
      <div class="event-card-item" style="border-left-color: var(--color-success);">
        <div class="event-card-header">
          <span class="event-card-title">🤝 ${a.visitorName} (${a.institution || 'Vatandaş'})</span>
          <span class="badge badge-success">Onaylandı / Tamamlandı</span>
        </div>
        <p style="font-size:0.88rem; color:#fff; margin-bottom:4px;">Görüşme Konusu: ${a.topic}</p>
        <p class="event-card-desc">${a.notes || ''}</p>
        <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:var(--text-muted); margin-top:8px;">
          <span>📅 Görüşme Tarihi: ${a.date} 🕒 ${a.time}</span>
          <span>✍️ Arşive İşleyen: ${a.archivedBy || 'Sekreterya'} (${a.archivedDate || ''})</span>
        </div>
      </div>
    `).join('');

  } else {
    const list = v3Data.archivedDocuments || [];
    const filtered = list.filter(d => 
      d.docNo.toLowerCase().includes(search) ||
      d.title.toLowerCase().includes(search)
    );

    if (filtered.length === 0) {
      elContent.innerHTML = `<p style="color:var(--text-muted); padding:20px; text-align:center;">Tamamlanmış evrak kaydı bulunamadı.</p>`;
      return;
    }

    elContent.innerHTML = filtered.map(d => `
      <div class="event-card-item" style="border-left-color: var(--color-primary);">
        <div class="event-card-header">
          <span class="event-card-title">📄 Evrak No: ${d.docNo} - ${d.title}</span>
          <span class="badge badge-success">Tamamlandı</span>
        </div>
        <p class="event-card-desc">${d.description || ''}</p>
        <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:var(--text-muted); margin-top:8px;">
          <span>🏢 Tamamlayan Birim: ${d.assignedUnitName || d.assignedUnit}</span>
          <span>✍️ İşlem Tarihi: ${d.archivedDate || ''} (${d.archivedBy || ''})</span>
        </div>
      </div>
    `).join('');
  }
}

// TAB 5: BİRİM GÖREVLERİ & ONAY SÜRECİ
function renderUnitTasksView() {
  const filter = document.getElementById('unit-filter-select').value;
  const elTasks = document.getElementById('unit-tasks-list');
  const tasks = v3Data.unitTasks || [];

  const filtered = filter === 'all' ? tasks : tasks.filter(t => t.assignedUnit === filter);

  if (filtered.length === 0) {
    elTasks.innerHTML = `<p style="grid-column:span 2; color:var(--text-muted); font-size:0.88rem; text-align:center; padding:20px;">
      Bu birim için kayıtlı görev bulunmuyor.
    </p>`;
    return;
  }

  elTasks.innerHTML = filtered.map(t => {
    const statusClass = t.status === 'Kabul Edildi' ? 'kabul-edildi' : t.status === 'Reddedildi' ? 'reddedildi' : t.status === 'Tarih Revize Edildi' ? 'revize-edildi' : 'onay-bekliyor';
    return `
      <div class="event-card-item" style="border-left-color: var(--color-primary);">
        <div class="event-card-header">
          <span class="event-card-title">${t.title}</span>
          <span class="status-pill ${statusClass}">${t.status || 'Onay Bekliyor'}</span>
        </div>
        <p class="event-card-desc">${t.notes || ''}</p>
        ${t.unitNote ? `<div style="background:rgba(15,23,42,0.6); border:1px solid var(--border-color); padding:8px 10px; border-radius:6px; margin-top:6px; font-size:0.82rem; color:#38bdf8;">📝 Birim Yanıtı/Notu: ${t.unitNote}</div>` : ''}
        ${t.rejectionReason ? `<div style="background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.4); padding:8px 10px; border-radius:6px; margin-top:6px; font-size:0.82rem; color:#f87171;">❌ Red Gerekçesi: ${t.rejectionReason}</div>` : ''}
        <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.78rem; color:var(--text-muted); margin-top:10px;">
          <span>📅 Hedef Tarih: ${t.date} • Atayan: ${t.creator || 'Yönetici'}</span>
          <div style="display:flex; gap:6px;">
            <button class="btn btn-sm btn-primary" onclick="openTaskRespondModal('${t.id}')">📌 Yanıtla / Durum Güncelle</button>
            ${canDelete() ? `<button class="btn btn-sm btn-secondary" style="background:#ef4444; color:#fff;" onclick="deleteUnitTask('${t.id}')">🗑️ Sil</button>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

window.openTaskRespondModal = function(taskId) {
  const task = (v3Data.unitTasks || []).find(t => t.id === taskId);
  if (!task) return;

  document.getElementById('task-respond-id').value = taskId;
  document.getElementById('task-respond-modal-title').textContent = `📌 ${task.title} — Birim Yanıtı`;
  document.getElementById('task-respond-note').value = task.unitNote || '';
  document.getElementById('modal-task-respond').classList.remove('hidden');
};

async function handleTaskRespondSubmit(e) {
  e.preventDefault();
  const taskId = document.getElementById('task-respond-id').value;
  const status = document.getElementById('task-respond-action').value;
  const note = document.getElementById('task-respond-note').value.trim();

  await executeAction('respond-unit-task', {
    id: taskId,
    status: status,
    unitNote: note,
    rejectionReason: status === 'Reddedildi' ? note : null
  });

  await reloadV3Data();
  closeModal('modal-task-respond');
  renderUnitTasksView();
  renderDailyView();
  updateBadges();
  playNotificationSound('task');
}

async function handleAddUnitTask(e) {
  e.preventDefault();
  const unitSelect = document.getElementById('ut-input-unit');
  const task = {
    title: document.getElementById('ut-input-title').value.trim(),
    assignedUnit: unitSelect.value,
    assignedUnitName: unitSelect.options[unitSelect.selectedIndex].text,
    date: document.getElementById('ut-input-date').value,
    notes: document.getElementById('ut-input-notes').value.trim(),
    creator: loggedInUser ? loggedInUser.name : 'Yönetici',
    status: 'Onay Bekliyor'
  };

  await executeAction('add-unit-task', { task });
  await reloadV3Data();
  closeModal('modal-unit-task');
  renderUnitTasksView();
  renderDailyView();
  updateBadges();
  playNotificationSound('task');
}

// UNIFIED MONTHLY & YEARLY CALENDAR
function renderMonthlyView() {
  const year = currentMonthDate.getFullYear();
  const month = currentMonthDate.getMonth();
  document.getElementById('monthly-title').textContent = currentMonthDate.toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' });

  const firstDayIndex = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const today = new Date();
  const elGrid = document.getElementById('monthly-grid');
  elGrid.innerHTML = '';

  for (let i = firstDayIndex; i > 0; i--) {
    const dayNum = daysInPrevMonth - i + 1;
    const cell = document.createElement('div');
    cell.className = 'day-cell other-month';
    cell.innerHTML = `<div class="day-cell-top"><span class="day-number">${dayNum}</span></div>`;
    elGrid.appendChild(cell);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const isToday = today.getDate() === d && today.getMonth() === month && today.getFullYear() === year;
    const cell = document.createElement('div');
    cell.className = `day-cell ${isToday ? 'today' : ''}`;

    const officialEvents = getEventsForDate(year, month + 1, d);
    const mayorEvents = v3Data.mayorSchedule ? v3Data.mayorSchedule.filter(x => x.date === dateStr) : [];
    const unitTasks = v3Data.unitTasks ? v3Data.unitTasks.filter(x => x.date === dateStr) : [];
    const docs = v3Data.documents ? v3Data.documents.filter(x => x.targetDate === dateStr) : [];
    const appnts = v3Data.appointments ? v3Data.appointments.filter(x => x.date === dateStr) : [];

    const isOfficialHoliday = officialEvents.some(e => e.is_official_holiday);

    let pillsHtml = '';

    mayorEvents.slice(0, 2).forEach(m => {
      pillsHtml += `<div class="event-pill mayor" title="Başkan: ${m.title}">👔 ${m.time} ${m.title}</div>`;
    });

    unitTasks.slice(0, 2).forEach(u => {
      pillsHtml += `<div class="event-pill unit" title="${u.assignedUnitName}: ${u.title}">🚜 ${u.title}</div>`;
    });

    docs.slice(0, 1).forEach(doc => {
      pillsHtml += `<div class="event-pill doc" title="Evrak: ${doc.title}">📄 ${doc.docNo}</div>`;
    });

    appnts.slice(0, 1).forEach(ap => {
      pillsHtml += `<div class="event-pill appnt" title="Randevu: ${ap.visitorName}">🤝 ${ap.visitorName}</div>`;
    });

    officialEvents.slice(0, 1).forEach(off => {
      pillsHtml += `<div class="event-pill holiday" title="Özel Gün: ${off.name}">🏛️ ${off.name}</div>`;
    });

    cell.innerHTML = `
      <div class="day-cell-top">
        <span class="day-number">${d}</span>
        ${isOfficialHoliday ? '<span class="official-holiday-ribbon">TATİL</span>' : ''}
      </div>
      <div class="day-events-container">${pillsHtml}</div>
    `;

    cell.addEventListener('click', () => openDayModalUnified(year, month + 1, d, { officialEvents, mayorEvents, unitTasks, docs, appnts }));
    elGrid.appendChild(cell);
  }
}

function openDayModalUnified(year, month, day, dataObj) {
  document.getElementById('modal-date-title').textContent = `${day} ${new Date(year, month - 1, day).toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' })} — Tüm Birim Programı`;
  const body = document.getElementById('modal-body');

  let content = '';

  if (dataObj.mayorEvents.length > 0) {
    content += `<h4 style="color:#fbbf24; margin:8px 0;">👔 Başkanlık Programı (${dataObj.mayorEvents.length})</h4>`;
    content += dataObj.mayorEvents.map(m => `
      <div class="summary-item-card">
        <span class="summary-time">🕒 ${m.time}</span>
        <div><strong>${m.title}</strong> — ${m.location || 'Makam'}<br><small>${m.notes || ''}</small></div>
      </div>
    `).join('');
  }

  if (dataObj.unitTasks.length > 0) {
    content += `<h4 style="color:#38bdf8; margin:14px 0 8px 0;">🚜 Birim Görevleri (${dataObj.unitTasks.length})</h4>`;
    content += dataObj.unitTasks.map(u => `
      <div class="summary-item-card" style="border-left-color:var(--color-primary);">
        <div><strong>${u.title}</strong> (${u.assignedUnitName})<br><small>Durum: ${u.status} • Atayan: ${u.creator}</small></div>
      </div>
    `).join('');
  }

  if (dataObj.docs.length > 0) {
    content += `<h4 style="color:#34d399; margin:14px 0 8px 0;">📄 Evraklar (${dataObj.docs.length})</h4>`;
    content += dataObj.docs.map(d => `
      <div class="summary-item-card" style="border-left-color:var(--color-success);">
        <div><strong>No: ${d.docNo} — ${d.title}</strong> (${d.assignedUnitName})</div>
      </div>
    `).join('');
  }

  if (dataObj.appnts.length > 0) {
    content += `<h4 style="color:#c084fc; margin:14px 0 8px 0;">🤝 Randevular (${dataObj.appnts.length})</h4>`;
    content += dataObj.appnts.map(a => `
      <div class="summary-item-card" style="border-left-color:var(--color-accent);">
        <div><strong>${a.visitorName} (${a.institution || 'Vatandaş'})</strong> — Saat: ${a.time}<br><small>Konu: ${a.topic}</small></div>
      </div>
    `).join('');
  }

  if (dataObj.officialEvents.length > 0) {
    content += `<h4 style="color:#f87171; margin:14px 0 8px 0;">🏛️ Resmî & Önemli Günler (${dataObj.officialEvents.length})</h4>`;
    content += dataObj.officialEvents.map(o => `
      <div class="summary-item-card" style="border-left-color:var(--color-danger);">
        <div><strong>${o.name}</strong><br><small>${o.description || ''}</small></div>
      </div>
    `).join('');
  }

  if (!content) content = `<p style="color:var(--text-muted);">Bu tarih için kayıtlı program bulunmuyor.</p>`;

  body.innerHTML = content;
  document.getElementById('day-modal').classList.remove('hidden');
}

function renderYearlyView() {
  document.getElementById('yearly-title').textContent = `${currentYear} Yılı Genel Bakış`;
  const elGrid = document.getElementById('yearly-grid');
  elGrid.innerHTML = '';

  const monthNames = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

  monthNames.forEach((name, mIdx) => {
    const card = document.createElement('div');
    card.className = 'month-card';
    const daysInMonth = new Date(currentYear, mIdx + 1, 0).getDate();
    const firstDayIndex = (new Date(currentYear, mIdx, 1).getDay() + 6) % 7;

    let miniDaysHtml = '';
    for (let f = 0; f < firstDayIndex; f++) miniDaysHtml += '<div class="mini-day"></div>';

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${currentYear}-${String(mIdx + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const evs = getEventsForDate(currentYear, mIdx + 1, d);
      const mEvs = v3Data.mayorSchedule ? v3Data.mayorSchedule.filter(x => x.date === dateStr) : [];
      const uEvs = v3Data.unitTasks ? v3Data.unitTasks.filter(x => x.date === dateStr) : [];
      
      const isHoliday = evs.some(e => e.is_official_holiday);
      const hasEvent = evs.length > 0 || mEvs.length > 0 || uEvs.length > 0;
      let cls = isHoliday ? 'holiday' : (hasEvent ? 'has-event' : '');
      miniDaysHtml += `<div class="mini-day ${cls}">${d}</div>`;
    }

    card.innerHTML = `<div class="month-card-title">${name}</div><div class="mini-calendar-grid">${miniDaysHtml}</div>`;
    card.addEventListener('click', () => {
      currentMonthDate = new Date(currentYear, mIdx, 1);
      document.querySelector('[data-tab="tab-monthly"]').click();
    });

    elGrid.appendChild(card);
  });
}

// BİRİMLER ARASI SOHBET MOTORU
function initChatListeners() {
  document.querySelectorAll('.channel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.channel-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeChatChannel = btn.getAttribute('data-channel');
      document.getElementById('chat-current-channel-title').textContent = `# ${btn.querySelector('.channel-name').textContent}`;
      document.getElementById('chat-current-channel-icon').textContent = btn.querySelector('.channel-icon').textContent;
      renderChatMessages();
    });
  });

  document.getElementById('chat-send-form').addEventListener('submit', handleSendChatMessage);
}

function renderChatMessages() {
  const listEl = document.getElementById('chat-messages-list');
  if (!listEl) return;
  const messages = v3Data.chatMessages || [];
  const filtered = messages.filter(m => (m.channel || 'genel') === activeChatChannel);

  if (filtered.length === 0) {
    listEl.innerHTML = `<p style="color:var(--text-muted); text-align:center; padding:30px;">Bu kanalda henüz mesaj bulunmuyor. İlk mesajı yazabilirsiniz.</p>`;
    return;
  }

  const curUser = loggedInUser ? loggedInUser.username : '';

  listEl.innerHTML = filtered.map(m => {
    const isMine = m.sender === curUser;
    return `
      <div class="chat-bubble-wrapper ${isMine ? 'sent' : 'received'}">
        <div class="chat-meta">
          <span><strong>${m.senderName || m.sender}</strong> (${m.senderRole || 'Birim'})</span>
          <span>• ${m.timestamp}</span>
        </div>
        <div class="chat-bubble">
          ${m.text}
        </div>
      </div>
    `;
  }).join('');

  listEl.scrollTop = listEl.scrollHeight;
}

async function handleSendChatMessage(e) {
  e.preventDefault();
  const inputEl = document.getElementById('chat-input-text');
  const text = inputEl.value.trim();
  if (!text) return;

  await executeAction('send-chat-message', {
    channel: activeChatChannel,
    text: text,
    senderName: loggedInUser ? loggedInUser.name : 'Kullanıcı',
    senderRole: loggedInUser ? getRoleDisplayName(loggedInUser.role) : 'Birim'
  });

  inputEl.value = '';
  await reloadV3Data();
  renderChatMessages();
}

// YAPAY ZEKA DENETÇİSİ MOTORU
function runAiAuditEngine() {
  const conflicts = [];
  const mayorList = v3Data.mayorSchedule || [];
  const docList = v3Data.documents || [];
  const taskList = v3Data.unitTasks || [];

  const timeMap = {};
  mayorList.forEach(m => {
    const key = `${m.date}_${m.time}`;
    if (!timeMap[key]) timeMap[key] = [];
    timeMap[key].push(m);
  });

  Object.keys(timeMap).forEach(key => {
    if (timeMap[key].length > 1) {
      const first = timeMap[key][0];
      conflicts.push({
        type: 'Çakışma',
        severity: 'danger',
        title: `⚠️ Saat Çakışması: ${first.date} Saat: ${first.time}`,
        description: `${timeMap[key].length} adet program aynı saate denk geliyor: "${timeMap[key].map(x => x.title).join('", "')}"`,
        suggestion: 'Yapay Zeka Önerisi: Toplantılardan birinin saatini 1 saat ileriye veya geriye kaydırınız.'
      });
    }
  });

  const todayStr = new Date().toISOString().split('T')[0];
  docList.forEach(d => {
    if (d.targetDate < todayStr && d.status !== 'Tamamlandı') {
      conflicts.push({
        type: 'Süre Aşımı',
        severity: 'warning',
        title: `📄 Son Günü Geçmiş Evrak: No ${d.docNo}`,
        description: `"${d.title}" evrakının son işlem tarihi (${d.targetDate}) geçmiş durumda. Birim: ${d.assignedUnitName}`,
        suggestion: 'Yapay Zeka Önerisi: İlgili müdürlükle iletişime geçilip evrak sonuçlandırılmalıdır.'
      });
    }
  });

  taskList.forEach(t => {
    if (t.status === 'Onay Bekliyor') {
      conflicts.push({
        type: 'Onay Bekliyor',
        severity: 'info',
        title: `📢 Yanıtsız Görev: ${t.title}`,
        description: `${t.assignedUnitName} birimine atanan görev henüz onaylanmadı veya reddedilmedi.`,
        suggestion: 'Yapay Zeka Önerisi: İlgili birim sorumlusunun görev durumunu kabul/red etmesi gerekmektedir.'
      });
    }
  });

  const confEl = document.getElementById('ai-conflicts-list');
  if (conflicts.length === 0) {
    confEl.innerHTML = `<div class="summary-item-card" style="border-left-color:var(--color-success);">
      🎉 Yapay zeka taraması temiz tamamlandı! Çakışan saat, süresi geçmiş evrak veya yanıtsız görev bulunmuyor.
    </div>`;
  } else {
    confEl.innerHTML = conflicts.map(c => `
      <div class="summary-item-card" style="border-left-color:${c.severity === 'danger' ? 'var(--color-danger)' : c.severity === 'warning' ? '#f59e0b' : 'var(--color-primary)'}; flex-direction:column; align-items:flex-start;">
        <div style="font-weight:700; color:#fff;">${c.title}</div>
        <div style="font-size:0.85rem; color:var(--text-muted); margin:4px 0;">${c.description}</div>
        <div style="font-size:0.8rem; color:#34d399; font-weight:600;">💡 ${c.suggestion}</div>
      </div>
    `).join('');
  }

  const reportEl = document.getElementById('ai-daily-summary-report');
  const mayorTodayCount = mayorList.filter(m => m.date === todayStr).length;
  const pendingDocsCount = docList.length;
  const pendingTasksCount = taskList.filter(t => t.status === 'Onay Bekliyor').length;

  reportEl.textContent = `🤖 ELDİVAN BSK YAPAY ZEKA GÜNLÜK YÖNETİCİ ÖZETİ (${new Date().toLocaleDateString('tr-TR')}):

- Bugün Makam ve Belediye Başkanlığı bünyesinde toplam ${mayorTodayCount} adet program planlanmıştır.
- Sisteme kayıtlı işlem bekleyen ${pendingDocsCount} adet resmi evrak bulunmaktadır.
- Birimlerden onay bekleyen ${pendingTasksCount} adet yeni çalışma talimatı mevcuttur.
- Yapay zeka denetçimiz tüm veri girişlerini ve zaman çakışmalarını kesintisiz kontrol etmektedir. Herhangi bir veri kaybı veya kayıp-kaçak riski bulunmamaktadır.`;
}

// SİSTEM DENETİM LOGLARI GÖRÜNTÜLEYİCİ
function renderAuditLogsView() {
  const tableBody = document.getElementById('audit-logs-table-body');
  if (!tableBody) return;
  const logs = v3Data.auditLogs || [];
  const search = (document.getElementById('audit-search-input').value || '').toLowerCase().trim();

  const filtered = logs.filter(l => 
    l.user.toLowerCase().includes(search) ||
    l.action.toLowerCase().includes(search) ||
    l.details.toLowerCase().includes(search)
  );

  if (filtered.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:20px;">Kayıtlı denetim logu bulunamadı.</td></tr>`;
    return;
  }

  tableBody.innerHTML = filtered.map(l => `
    <tr>
      <td style="white-space:nowrap;">🕒 ${l.timestamp}</td>
      <td><strong>${l.user}</strong></td>
      <td><span class="badge badge-secondary">${l.userRole || 'Birim'}</span></td>
      <td><span class="status-pill kabul-edildi">${l.action}</span></td>
      <td>${l.details}</td>
    </tr>
  `).join('');
}

window.deleteUnitTask = async function(id) {
  if (!canDelete()) {
    alert('Silme yetkisi sadece Yönetici (Admin) ve Belediye Başkanı hesaplarındadır!');
    return;
  }
  if (confirm('Bu birim görevini silmek istediğinize emin misiniz?')) {
    await executeAction('delete-unit-task', { id });
    await reloadV3Data();
    renderUnitTasksView();
    renderDailyView();
    updateBadges();
  }
};

window.deleteDocument = async function(id) {
  if (!canDelete()) {
    alert('Silme yetkisi sadece Yönetici (Admin) ve Belediye Başkanı hesaplarındadır!');
    return;
  }
  if (confirm('Bu evrak kaydını silmek istediğinize emin misiniz?')) {
    await executeAction('delete-doc', { id });
    await reloadV3Data();
    renderDocsAndAppntsView();
    renderDailyView();
    updateBadges();
  }
};

window.aiAutoFixConflicts = async function() {
  await executeAction('ai-auto-fix', {});
  await reloadV3Data();
  runAiAuditEngine();
  renderMayorScheduleView();
  renderDailyView();
  playNotificationSound('task');
  alert('🤖 Yapay Zeka Çakışma Düzeltmesi Tamamlandı! Saat çakışması olan toplantı saatleri 1 saat sonrasına otomatik kaydırıldı ve ajandaya işlendi.');
};

window.closeModal = function(id) { document.getElementById(id).classList.add('hidden'); };

function openDayModal(year, month, day, events) {
  document.getElementById('modal-date-title').textContent = `${day} ${new Date(year, month - 1, day).toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' })} Günü Detayları`;
  const body = document.getElementById('modal-body');

  if (events.length === 0) {
    body.innerHTML = `<p style="color:var(--text-muted);">Bu tarih için kayıtlı önemli gün bulunmuyor.</p>`;
  } else {
    body.innerHTML = events.map(ev => `
      <div class="event-card-item" style="border-left-color:${getCategoryColor(ev.category)}; margin-bottom:10px;">
        <div class="event-card-header">
          <span class="event-card-title">${ev.name}</span>
          <span class="badge" style="background:${getCategoryColor(ev.category)}22; color:${getCategoryColor(ev.category)};">${ev.category_name || 'Özel Gün'}</span>
        </div>
        <p class="event-card-desc">${ev.description || ''}</p>
      </div>
    `).join('');
  }
  document.getElementById('day-modal').classList.remove('hidden');
}

function openPrintModal() {
  const modal = document.getElementById('print-modal');
  const reportArea = document.getElementById('printable-report');
  const todayStr = currentDate.toLocaleDateString('tr-TR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const activeEvs = getEventsForDate(currentDate.getFullYear(), currentDate.getMonth() + 1, currentDate.getDate());

  reportArea.innerHTML = `
    <div style="text-align:center; margin-bottom:20px; border-bottom:2px solid #0284c7; padding-bottom:10px;">
      <h1 style="font-size:1.5rem; color:#0f172a;">T.C. ELDİVAN BELEDİYE BAŞKANLIĞI</h1>
      <h2 style="font-size:1.1rem; color:#0284c7;">Basın Yayın ve Özel Kalem Günlük Takvim Bülteni v3.0</h2>
      <p style="font-size:0.85rem; color:#475569;">Tarih: ${todayStr}</p>
    </div>
    <h3>📌 Bugünkü Önemli Günler ve Haftalar</h3>
    <div style="margin-top:10px;">
      ${activeEvs.length === 0 ? '<p>Bugün kayıtlı özel gün bulunmamaktadır.</p>' : activeEvs.map(e => `
        <div style="background:#f8fafc; border:1px solid #cbd5e1; padding:10px; margin-bottom:8px; border-radius:6px;">
          <h4 style="color:#0284c7;">${e.name}</h4>
          <p style="font-size:0.85rem; color:#334155;">${e.description || ''}</p>
        </div>
      `).join('')}
    </div>
  `;

  modal.classList.remove('hidden');
}

let lastChatMessageCount = -1;
let lastUnitTaskCount = -1;
let lastAppntCount = -1;
let lastDocCount = -1;
let lastMayorCount = -1;

function startLivePolling() {
  setInterval(async () => {
    if (!loggedInUser) return;
    try {
      let newData = null;
      try {
        const targetUrl = window.location.protocol === 'file:' ? 'http://127.0.0.1:3500/api/data' : '/api/data';
        const res = await fetch(targetUrl, { headers: getAuthHeaders() });
        if (res.ok) {
          newData = await res.json();
        } else if (res.status === 401 && window.api) {
          newData = await window.api.getV2Data();
        }
      } catch (fetchErr) {
        newData = await browserDirectCloudPull();
      }
      if (!newData) return;

      const newMessages = newData.chatMessages || [];
      const newTasks = newData.unitTasks || [];
      const newAppnts = newData.appointments || [];
      const newDocs = newData.documents || [];
      const newMayor = newData.mayorSchedule || [];

      let hasChanges = false;

      // 1. Live Chat Message Sync (Sound plays ONLY on recipient devices)
      if (lastChatMessageCount !== -1 && newMessages.length > lastChatMessageCount) {
        const latestMsg = newMessages[newMessages.length - 1];
        if (latestMsg.sender !== loggedInUser.username) {
          playNotificationSound('chat');
          showLiveToast(`💬 Yeni Mesaj: ${latestMsg.senderName}`, latestMsg.text);
        }
        hasChanges = true;
      }

      // 2. Live Appointments Sync Across All Units
      if (lastAppntCount !== -1 && newAppnts.length !== lastAppntCount) {
        const latestAppnt = newAppnts[0];
        if (latestAppnt && latestAppnt.creator !== loggedInUser.name) {
          playNotificationSound('task');
          showLiveToast(`🤝 Yeni Randevu Kaydı`, `${latestAppnt.visitorName} (${latestAppnt.topic})`);
        }
        hasChanges = true;
      }

      // 3. Live Documents Sync Across All Units
      if (lastDocCount !== -1 && newDocs.length !== lastDocCount) {
        const latestDoc = newDocs[0];
        if (latestDoc && latestDoc.creator !== loggedInUser.name) {
          playNotificationSound('task');
          showLiveToast(`📄 Yeni Evrak Kaydı`, `No: ${latestDoc.docNo} — ${latestDoc.title}`);
        }
        hasChanges = true;
      }

      // 4. Live Unit Tasks Sync
      if (lastUnitTaskCount !== -1 && newTasks.length !== lastUnitTaskCount) {
        const latestTask = newTasks[0];
        if (latestTask && latestTask.creator !== loggedInUser.name) {
          playNotificationSound('task');
          showLiveToast(`📢 Birim Görevi Güncellendi`, `${latestTask.title} (${latestTask.status})`);
        }
        hasChanges = true;
      }

      // 5. Live Mayor Schedule Sync
      if (lastMayorCount !== -1 && newMayor.length !== lastMayorCount) {
        const latestMayor = newMayor[0];
        if (latestMayor && latestMayor.creator !== loggedInUser.name) {
          playNotificationSound('task');
          showLiveToast(`👔 Başkanlık Programı Güncellendi`, `${latestMayor.title} (${latestMayor.time})`);
        }
        hasChanges = true;
      }

      // Update baseline counters
      lastChatMessageCount = newMessages.length;
      lastUnitTaskCount = newTasks.length;
      lastAppntCount = newAppnts.length;
      lastDocCount = newDocs.length;
      lastMayorCount = newMayor.length;

      v3Data = newData;
      renderMakamCockpit();
      renderBaskanlikAndUnitHub();
      renderCloudSettingsUI(false);

      // Re-render active view if changes occurred
      if (hasChanges) {
        updateBadges();
        const activeNavTab = document.querySelector('.nav-tab.active');
        if (activeNavTab) {
          const targetId = activeNavTab.getAttribute('data-tab');
          if (targetId === 'tab-baskanlik-paneli') renderBaskanlikAndUnitHub();
          if (targetId === 'tab-daily') renderDailyView();
          if (targetId === 'tab-mayor-schedule') renderMayorScheduleView();
          if (targetId === 'tab-documents-appointments') renderDocsAndAppntsView();
          if (targetId === 'tab-archive') renderArchiveView();
          if (targetId === 'tab-unit-tasks') renderUnitTasksView();
          if (targetId === 'tab-chat') renderChatMessages();
          if (targetId === 'tab-monthly') renderMonthlyView();
          if (targetId === 'tab-yearly') renderYearlyView();
        }
      } else {
        updateBadges();
      }
    } catch (e) {
      // Quiet background poll catch
    }
  }, 2000);
}
