const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getEventsDb: () => ipcRenderer.invoke('get-events-db'),
  getV2Data: () => ipcRenderer.invoke('get-v2-data'),
  saveV2Data: (data) => ipcRenderer.invoke('save-v2-data', data),
  
  // Login & User Auth
  loginUser: (credentials) => ipcRenderer.invoke('login-user', credentials),
  validateAdminPassword: (pass) => ipcRenderer.invoke('validate-admin-password', pass),
  changeAdminPassword: (newPass) => ipcRenderer.invoke('change-admin-password', newPass),
  
  // Mayor Schedule
  addMayorEngagement: (item) => ipcRenderer.invoke('add-mayor-engagement', item),
  deleteMayorEngagement: (id) => ipcRenderer.invoke('delete-mayor-engagement', id),

  // Documents & Archive
  addDocument: (doc) => ipcRenderer.invoke('add-document', doc),
  updateDocumentStatus: (id, status, user) => ipcRenderer.invoke('update-document-status', { id, status, user }),
  deleteDocument: (id) => ipcRenderer.invoke('delete-document', id),

  // Appointments & Archive
  addAppointment: (appnt) => ipcRenderer.invoke('add-appointment', appnt),
  updateAppointmentStatus: (id, status, user) => ipcRenderer.invoke('update-appointment-status', { id, status, user }),
  deleteAppointment: (id) => ipcRenderer.invoke('delete-appointment', id),

  // Unit Tasks
  assignUnitTask: (task) => ipcRenderer.invoke('assign-unit-task', task),

  // File Save (JPEG Export)
  saveJpgImage: (data) => ipcRenderer.invoke('save-jpg-image', data),

  // System & Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  getServerInfo: () => ipcRenderer.invoke('get-server-info'),
  sendNotification: (title, body) => ipcRenderer.invoke('send-notification', { title, body }),
  toggleAutostart: (enable) => ipcRenderer.invoke('toggle-autostart', enable),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  closeWindow: () => ipcRenderer.send('window-close')
});
