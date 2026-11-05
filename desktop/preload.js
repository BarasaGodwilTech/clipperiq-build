'use strict';
// Intentionally minimal: the app is a normal web app. This marks the page as running inside the desktop program.
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('clipperiqDesktop', { isDesktop: true, platform: process.platform });
