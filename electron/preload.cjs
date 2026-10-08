/** Bridge between the desktop shell and the web UI (no Node access in the page). */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cadDesktop', {
  isDesktop: true,
  onOpenFiles(callback) {
    ipcRenderer.on('open-files', (_e, files) => callback(files));
  },
  openDialog: () => ipcRenderer.invoke('open-dialog'),
});
