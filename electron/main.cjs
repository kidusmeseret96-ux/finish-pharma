const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

app.setAppUserModelId('com.yoya.pharmacy');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow = null;
let serverProcess = null;
let isQuitting = false;

function loadOptionalEnvFile(filePath) {
  const loaded = {};
  if (!fs.existsSync(filePath)) return loaded;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key) loaded[key] = val;
    }
  } catch {
    // Ignore malformed optional desktop .env file
  }
  return loaded;
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, '127.0.0.1');
  });
}

async function pickServerPort(preferredPort = 3000) {
  if (await isPortAvailable(preferredPort)) {
    return preferredPort;
  }
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 3000;
      srv.close(() => resolve(port));
    });
  });
}

function waitForServer(url, retries = 80) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (left <= 0) {
          reject(new Error('Local YOYA Pharmacy server did not start in time.'));
          return;
        }
        setTimeout(() => attempt(left - 1), 250);
      });
    };
    attempt(retries);
  });
}

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill();
    } catch {
      // Ignore already exited child process
    }
    serverProcess = null;
  }
}

function createWindow(port) {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    title: 'YOYA Pharmacy',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#0A1114',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const targetUrl = `http://127.0.0.1:${port}`;
  waitForServer(`${targetUrl}/api/auth/status`)
    .then(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(targetUrl);
      }
    })
    .catch((err) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#0A1114;color:#F0F6FF;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="max-width:480px;padding:28px;border-radius:20px;background:#111C22;border:1px solid #1F3037;"><h2 style="margin:0 0 8px;color:#34D399;">YOYA Pharmacy Failed to Start</h2><p style="margin:0;color:#94A3B8;font-size:14px;line-height:1.5;">${String(err.message || err)}</p></div></body></html>`;
        mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      }
    });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  const appRoot = path.join(__dirname, '..');
  const userDataDir = app.getPath('userData');
  const dataDir = path.join(userDataDir, 'data');
  const logDir = path.join(userDataDir, 'logs');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const userEnv = {
    ...loadOptionalEnvFile(path.join(appRoot, '.env')),
    ...loadOptionalEnvFile(path.join(userDataDir, '.env')),
    ...loadOptionalEnvFile(path.join(userDataDir, 'yoya.env')),
  };

  const port = await pickServerPort(Number(userEnv.PORT || process.env.PORT || 3000));
  const bundledServer = path.join(appRoot, 'dist-server', 'server.mjs');
  const logStream = fs.createWriteStream(path.join(logDir, 'server.log'), { flags: 'a' });

  let command = process.execPath;
  let args = [bundledServer];
  if (!fs.existsSync(bundledServer)) {
    // Fallback for local Electron development before build:server is run
    const tsxCli = require.resolve('tsx/cli');
    args = [tsxCli, path.join(appRoot, 'server.ts')];
  }

  serverProcess = spawn(command, args, {
    cwd: appRoot,
    env: {
      ...process.env,
      ...userEnv,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(port),
      YOYA_DATA_DIR: dataDir,
      YOYA_APP_ROOT: appRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  if (serverProcess.stdout) serverProcess.stdout.pipe(logStream);
  if (serverProcess.stderr) serverProcess.stderr.pipe(logStream);

  serverProcess.on('exit', (code) => {
    if (!isQuitting && code && code !== 0) {
      dialog.showErrorBox(
        'YOYA Pharmacy Server Stopped',
        `The local pharmacy engine exited unexpectedly (code ${code}). Check ${path.join(logDir, 'server.log')}.`
      );
    }
  });

  createWindow(port);
});

app.on('before-quit', () => {
  isQuitting = true;
  stopServer();
});

app.on('window-all-closed', () => {
  isQuitting = true;
  stopServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
