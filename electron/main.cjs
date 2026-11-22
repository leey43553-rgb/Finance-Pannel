const { app, BrowserWindow, ipcMain, dialog, Menu, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
let mainWindow = null;
let isQuittingWithBackup = false;

function getDefaultBackupDir() {
  return path.join(app.getPath('documents'), 'GestionFinanciere', 'Sauvegardes');
}

function getConfigPath() {
  return path.join(app.getPath('userData'), 'desktop-config.json');
}

function readDesktopConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeDesktopConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2), 'utf-8');
  } catch {
    // Ignorer si écriture impossible
  }
}

function resolveBackupDir(customDir) {
  if (customDir && typeof customDir === 'string' && customDir.trim()) {
    return customDir.trim();
  }
  const cfg = readDesktopConfig();
  return cfg.backupDir || getDefaultBackupDir();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function formatTimestampForFilename(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function isValidBackupFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Boolean(parsed && parsed.app === 'Gestion Financière' && parsed.data && typeof parsed.data === 'object');
  } catch {
    return false;
  }
}

function pruneOldAutoBackups(dirPath, keepCount = 30) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.startsWith('gestion-financiere-auto-') && e.name.endsWith('.json'))
      .map((e) => {
        const fullPath = path.join(dirPath, e.name);
        const stat = fs.statSync(fullPath);
        return { name: e.name, fullPath, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (entries.length <= keepCount) return;

    const validFiles = entries.filter((f) => isValidBackupFile(f.fullPath));
    // Ne jamais supprimer l'unique sauvegarde valide
    if (validFiles.length <= 1) return;

    const toDelete = entries.slice(keepCount);
    let remainingValid = validFiles.length;

    for (const file of toDelete) {
      const valid = isValidBackupFile(file.fullPath);
      if (valid && remainingValid <= 1) {
        continue;
      }
      fs.unlinkSync(file.fullPath);
      if (valid) remainingValid -= 1;
    }
  } catch {
    // Conserver les fichiers existants en cas d'erreur de lecture
  }
}

function writeBackupToDisk(jsonContent, kind = 'manual', customDir = '') {
  const targetDir = resolveBackupDir(customDir);
  ensureDir(targetDir);

  // Vérification JSON basique avant écriture
  const parsed = JSON.parse(jsonContent);
  if (!parsed || !parsed.data) {
    throw new Error('Contenu de sauvegarde invalide.');
  }

  const prefix = kind === 'auto' ? 'gestion-financiere-auto-' : 'gestion-financiere-manuel-';
  const fileName = `${prefix}${formatTimestampForFilename()}.json`;
  const filePath = path.join(targetDir, fileName);

  fs.writeFileSync(filePath, jsonContent, 'utf-8');

  if (kind === 'auto') {
    pruneOldAutoBackups(targetDir, 30);
  }

  return { filePath, fileName, directory: targetDir };
}

function listBackupsOnDisk(customDir = '') {
  const targetDir = resolveBackupDir(customDir);
  if (!fs.existsSync(targetDir)) {
    return { directory: targetDir, backups: [] };
  }

  const entries = fs.readdirSync(targetDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => {
      const fullPath = path.join(targetDir, e.name);
      const stat = fs.statSync(fullPath);
      return {
        fileName: e.name,
        filePath: fullPath,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        kind: e.name.includes('-auto-') ? 'auto' : 'manual',
      };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));

  return { directory: targetDir, backups: entries };
}

function setupOfflineSecurity() {
  // Bloquer TOUTE requête réseau externe (hors fichiers locaux et dev local)
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url || '';
    const isLocalFile = url.startsWith('file://') || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('devtools://');
    const isDevLocal =
      isDev &&
      (url.startsWith('http://localhost:3000') ||
        url.startsWith('http://127.0.0.1:3000') ||
        url.startsWith('ws://localhost:3000') ||
        url.startsWith('ws://127.0.0.1:3000'));

    if (isLocalFile || isDevLocal) {
      callback({ cancel: false });
    } else {
      callback({ cancel: true });
    }
  });
}

function createWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 840,
    minWidth: 1100,
    minHeight: 700,
    title: 'Gestion Financière',
    autoHideMenuBar: true,
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Bloquer toute navigation externe et ouverture de fenêtre
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (isDev && targetUrl.startsWith('http://localhost:3000')) {
      return;
    }
    if (targetUrl.startsWith('file://')) {
      return;
    }
    event.preventDefault();
  });

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // Sauvegarde automatique à la fermeture
  mainWindow.on('close', (event) => {
    if (isQuittingWithBackup) {
      return;
    }
    event.preventDefault();
    isQuittingWithBackup = true;

    const timeout = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy();
      }
    }, 3500);

    try {
      mainWindow.webContents.send('app:request-close-backup');
      ipcMain.once('app:close-backup-done', () => {
        clearTimeout(timeout);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.destroy();
        }
      });
    } catch {
      clearTimeout(timeout);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy();
      }
    }
  });
}

app.whenReady().then(() => {
  setupOfflineSecurity();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      isQuittingWithBackup = false;
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC Handlers sécurisés
ipcMain.handle('backup:save', async (_event, payload) => {
  try {
    const { jsonContent, kind, customDir } = payload || {};
    const result = writeBackupToDisk(jsonContent, kind || 'manual', customDir || '');
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Erreur lors de la sauvegarde.' };
  }
});

ipcMain.handle('backup:list', async (_event, customDir) => {
  try {
    const result = listBackupsOnDisk(customDir || '');
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Impossible de lister les sauvegardes.' };
  }
});

ipcMain.handle('backup:restore', async (_event, filePath) => {
  try {
    let targetPath = filePath;
    if (!targetPath) {
      const res = await dialog.showOpenDialog(mainWindow, {
        title: 'Choisir un fichier de sauvegarde',
        defaultPath: resolveBackupDir(),
        filters: [{ name: 'Sauvegarde JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (res.canceled || res.filePaths.length === 0) {
        return { ok: false, canceled: true };
      }
      targetPath = res.filePaths[0];
    }

    const raw = fs.readFileSync(targetPath, 'utf-8');
    return { ok: true, filePath: targetPath, jsonContent: raw };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Erreur de lecture du fichier.' };
  }
});

ipcMain.handle('backup:selectFolder', async (_event, currentDir) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choisir le dossier des sauvegardes automatiques',
    defaultPath: resolveBackupDir(currentDir),
    properties: ['openDirectory', 'createDirectory'],
  });

  if (res.canceled || res.filePaths.length === 0) {
    return { ok: false, canceled: true };
  }

  const chosen = res.filePaths[0];
  const cfg = readDesktopConfig();
  cfg.backupDir = chosen;
  writeDesktopConfig(cfg);
  return { ok: true, directory: chosen };
});

ipcMain.handle('backup:getDefaultFolder', async () => {
  return { ok: true, directory: resolveBackupDir() };
});

function normalizePrintRouteHash(printRoute) {
  if (!printRoute || typeof printRoute !== 'string') return '';
  const trimmed = printRoute.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('#')) return trimmed;
  return `#${trimmed.startsWith('/') ? trimmed : `/${trimmed}`}`;
}

async function createAndLoadHiddenPrintWindow({ printRoute, htmlContent }) {
  const hiddenWin = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  hiddenWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const waitForDidFinishLoad = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Délai de chargement impression dépassé.')), 10000);
      hiddenWin.webContents.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve();
      });
      hiddenWin.webContents.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timer);
        reject(new Error(desc || `Échec de chargement (${code}).`));
      });
    });

  if (htmlContent && typeof htmlContent === 'string') {
    const loadPromise = waitForDidFinishLoad();
    await hiddenWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);
    await loadPromise;
    await hiddenWin.webContents
      .executeJavaScript(
        `Promise.all([
          document.fonts ? document.fonts.ready : Promise.resolve(),
          ...Array.from(document.images).map(img => img.complete ? Promise.resolve() : new Promise(r => { img.onload = r; img.onerror = r; setTimeout(r, 1500); }))
        ]).then(() => true)`
      )
      .catch(() => true);
    await new Promise((r) => setTimeout(r, 120));
    return hiddenWin;
  }

  const hash = normalizePrintRouteHash(printRoute);
  const loadPromise = waitForDidFinishLoad();
  if (isDev) {
    const base = String(process.env.VITE_DEV_SERVER_URL || 'http://localhost:3000').replace(/#.*$/, '');
    await hiddenWin.loadURL(`${base}${hash}`);
  } else {
    const distFile = path.join(__dirname, '..', 'dist', 'index.html');
    await hiddenWin.loadFile(distFile, { hash: hash.replace(/^#/, '') });
  }
  await loadPromise;

  // Attendre que la route d'impression Dexie signale [data-print-ready="true"]
  if (hash) {
    const started = Date.now();
    while (Date.now() - started < 5500) {
      const ready = await hiddenWin.webContents
        .executeJavaScript(
          `(() => {
            const el = document.querySelector('[data-print-ready="true"]');
            if (!el) return false;
            const imgs = Array.from(document.images);
            return imgs.every(img => img.complete);
          })()`
        )
        .catch(() => false);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 70));
    }
  }

  await hiddenWin.webContents
    .executeJavaScript(`document.fonts ? document.fonts.ready.then(() => true) : true`)
    .catch(() => true);
  await new Promise((r) => setTimeout(r, 120));
  return hiddenWin;
}

ipcMain.handle('printers:list', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, printers: [], error: 'Fenêtre introuvable.' };
  }
  try {
    const list = await mainWindow.webContents.getPrintersAsync();
    const printers = (list || []).map((p) => ({
      name: p.name,
      displayName: p.displayName || p.name,
      description: p.description || '',
      isDefault: Boolean(p.isDefault),
      status: p.status,
    }));
    return { ok: true, printers };
  } catch (err) {
    return {
      ok: false,
      printers: [],
      error: err instanceof Error ? err.message : 'Impossible de lister les imprimantes.',
    };
  }
});

ipcMain.handle('pdf:printToPDF', async (_event, options) => {
  if (!mainWindow) {
    return { ok: false, error: 'Fenêtre introuvable.' };
  }

  let hiddenWin = null;
  try {
    const defaultName = (options && options.defaultFileName) || 'document-gestion-financiere.pdf';
    const companyName =
      options && typeof options.companyName === 'string' && options.companyName.trim()
        ? options.companyName.trim()
        : 'Gestion Financière';
    const isRawA4 = Boolean(options && options.rawLayout);
    const pageSize = (options && options.paperSize) || 'A4';
    const landscape = Boolean(options && options.landscape);

    const saveRes = await dialog.showSaveDialog(mainWindow, {
      title: 'Enregistrer le document en PDF',
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: [{ name: 'Document PDF', extensions: ['pdf'] }],
    });

    if (saveRes.canceled || !saveRes.filePath) {
      return { ok: false, canceled: true };
    }

    let targetWebContents = mainWindow.webContents;
    if ((options && options.printRoute) || (options && options.htmlContent)) {
      hiddenWin = await createAndLoadHiddenPrintWindow({
        printRoute: options.printRoute,
        htmlContent: options.htmlContent,
      });
      targetWebContents = hiddenWin.webContents;
    }

    const safeCompany = companyName.replace(/[<>&"]/g, '');
    const pdfBuffer = await targetWebContents.printToPDF(
      isRawA4 || Boolean(options && options.htmlContent)
        ? {
            printBackground: true,
            pageSize,
            landscape,
            displayHeaderFooter: false,
            margins: { marginType: 'none' },
          }
        : {
            printBackground: true,
            pageSize,
            landscape,
            displayHeaderFooter: true,
            headerTemplate: '<div></div>',
            footerTemplate: `<div style="width:100%;font-family:Arial,sans-serif;font-size:8px;color:#64748b;padding:0 12mm;display:flex;justify-content:space-between;align-items:center;"><span>${safeCompany} — Gestion Financière</span><span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
            margins: { top: 0.45, bottom: 0.65, left: 0.4, right: 0.4 },
          }
    );

    fs.writeFileSync(saveRes.filePath, pdfBuffer);
    return { ok: true, filePath: saveRes.filePath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Erreur lors de la génération PDF.' };
  } finally {
    if (hiddenWin && !hiddenWin.isDestroyed()) {
      hiddenWin.destroy();
    }
  }
});

ipcMain.handle('pdf:openFolder', async (_event, filePath) => {
  try {
    if (filePath && typeof filePath === 'string') {
      shell.showItemInFolder(filePath);
      return { ok: true };
    }
    return { ok: false, error: 'Chemin introuvable.' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Impossible d’ouvrir le dossier.' };
  }
});

ipcMain.handle('pdf:printDirect', async (_event, options = {}) => {
  if (!mainWindow) return { ok: false, error: 'Fenêtre introuvable.' };

  let hiddenWin = null;
  try {
    let targetWebContents = mainWindow.webContents;
    if ((options && options.printRoute) || (options && options.htmlContent)) {
      hiddenWin = await createAndLoadHiddenPrintWindow({
        printRoute: options.printRoute,
        htmlContent: options.htmlContent,
      });
      targetWebContents = hiddenWin.webContents;
    }

    const ps = (options && options.printSettings) || {};
    const marginType =
      ps.margins === 'none' ? 'none' : ps.margins === 'minimum' ? 'minimum' : 'default';
    const printOpts = {
      silent: Boolean(ps.silentPrint),
      printBackground: true,
      deviceName:
        typeof ps.defaultPrinterName === 'string' && ps.defaultPrinterName.trim()
          ? ps.defaultPrinterName.trim()
          : undefined,
      color: ps.color !== undefined ? Boolean(ps.color) : true,
      copies: Math.max(1, Number(ps.copies) || 1),
      landscape: ps.orientation === 'landscape',
      pageSize: ps.paperSize || 'A4',
      margins: { marginType },
    };

    return await new Promise((resolve) => {
      targetWebContents.print(printOpts, (success, failureReason) => {
        if (!success) {
          resolve({ ok: false, error: failureReason || 'Impression annulée.' });
        } else {
          resolve({ ok: true });
        }
      });
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Erreur lors de l’impression.',
    };
  } finally {
    if (hiddenWin && !hiddenWin.isDestroyed()) {
      hiddenWin.destroy();
    }
  }
});
