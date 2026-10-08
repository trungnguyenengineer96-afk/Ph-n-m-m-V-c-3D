/** Bridge between the desktop shell and the web UI (no Node access in the page). */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cadDesktop', {
  isDesktop: true,
  onOpenFiles(callback) {
    ipcRenderer.on('open-files', (_e, files) => callback(files));
  },
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  // Only exposed when the native STEP/IGES importer is bundled with the app.
  ...(ipcRenderer.sendSync('native-available')
    ? { importNative: (name, data, linear, angular) => ipcRenderer.invoke('native-import', name, data, linear, angular) }
    : {}),
});
