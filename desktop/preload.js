'use strict';
// The app is a normal web page; this only adds the few things a desktop program can do that a web page can't.
const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('clipperiqDesktop', {
  isDesktop: true, platform: process.platform,
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),        // native folder picker for Settings > Storage
  getPathForFile: (file) => webUtils.getPathForFile(file),         // where a chosen / dropped file is on disk, so it is used in place (no upload)
  setProgress: (fraction) => ipcRenderer.send('set-progress', Number(fraction)), // taskbar progress; -1 hides it
});
