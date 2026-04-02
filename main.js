const { app, BrowserWindow, Tray, Menu, nativeImage, shell, clipboard } = require('electron');
const remoteMain = require('@electron/remote/main');
const path = require('path');
const fs = require('fs');
const { startServer, listPrinters, PORT } = require('./server');

remoteMain.initialize();

const CONFIG_DIR = path.join(app.getPath('home'), '.mpt-mac');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function createSFSymbolIcon() {
  try {
    const swift = `
import Cocoa
let scale: CGFloat = 2.0
let w: CGFloat = 18
let h: CGFloat = 18
let size = NSSize(width: w * scale, height: h * scale)
let img = NSImage(size: size)
img.lockFocus()
NSGraphicsContext.current?.cgContext.scaleBy(x: scale, y: scale)
if let symbol = NSImage(systemSymbolName: "printer.fill", accessibilityDescription: nil) {
    let config = NSImage.SymbolConfiguration(pointSize: 14, weight: .medium)
    let configured = symbol.withSymbolConfiguration(config)!
    configured.draw(in: NSRect(x: 1, y: 1, width: 16, height: 16))
}
img.unlockFocus()
let tiff = img.tiffRepresentation!
let bitmap = NSBitmapImageRep(data: tiff)!
let png = bitmap.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: "/tmp/mpt-sf-icon.png"))
`;
    fs.writeFileSync('/tmp/mpt-sf-icon.swift', swift);
    require('child_process').execSync('swift /tmp/mpt-sf-icon.swift 2>/dev/null');
    const raw = nativeImage.createFromPath('/tmp/mpt-sf-icon.png');
    // Resize to 18x18 so Electron treats the 36px image as @2x Retina
    const icon = raw.resize({ width: 18, height: 18 });
    icon.setTemplateImage(true);
    return icon;
  } catch {
    // Fallback to bundled icon
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'iconTemplate.png'));
    icon.setTemplateImage(true);
    return icon;
  }
}

let tray = null;
let wizardWindow = null;
let dropdownWindow = null;

function isFirstLaunch() {
  return !fs.existsSync(CONFIG_FILE);
}

function saveConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function createTray() {
  const icon = createSFSymbolIcon();
  tray = new Tray(icon);
  tray.setToolTip('Mainchain Printing Tool');

  tray.on('click', (event, bounds) => {
    if (dropdownWindow && dropdownWindow.isVisible()) {
      dropdownWindow.hide();
      return;
    }
    showDropdown(bounds);
  });

  tray.on('right-click', () => {
    const contextMenu = Menu.buildFromTemplate([
      { label: `MPT Mac v1.0.0 - Port ${PORT}`, enabled: false },
      { type: 'separator' },
      { label: 'Open Freman', click: () => shell.openExternal('https://fremanspanz-mchaincfa.mainchain.net') },
      { label: 'Change Port...', click: () => showPortDialog() },
      { label: 'Run Setup Wizard', click: () => showWizard() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ]);
    tray.popUpContextMenu(contextMenu);
  });
}

function showDropdown(bounds) {
  if (dropdownWindow) {
    dropdownWindow.destroy();
  }

  const width = 320;
  const height = 400;

  dropdownWindow = new BrowserWindow({
    x: Math.round(bounds.x - width / 2),
    y: bounds.y + bounds.height,
    width,
    height,
    frame: false,
    resizable: false,
    movable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  remoteMain.enable(dropdownWindow.webContents);
  dropdownWindow.loadFile(path.join(__dirname, 'ui', 'dropdown.html'));
  dropdownWindow.once('ready-to-show', () => dropdownWindow.show());
  dropdownWindow.on('blur', () => {
    if (dropdownWindow && !dropdownWindow.isDestroyed()) {
      dropdownWindow.hide();
    }
  });
}

function showWizard() {
  if (wizardWindow) {
    wizardWindow.focus();
    return;
  }

  wizardWindow = new BrowserWindow({
    width: 560,
    height: 480,
    titleBarStyle: 'hiddenInset',
    resizable: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  remoteMain.enable(wizardWindow.webContents);
  wizardWindow.loadFile(path.join(__dirname, 'ui', 'wizard.html'));
  wizardWindow.once('ready-to-show', () => wizardWindow.show());
  wizardWindow.on('closed', () => { wizardWindow = null; });
}

function showPortDialog() {
  const portWindow = new BrowserWindow({
    width: 380,
    height: 200,
    titleBarStyle: 'hiddenInset',
    resizable: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  remoteMain.enable(portWindow.webContents);
  portWindow.loadFile(path.join(__dirname, 'ui', 'port.html'));
  portWindow.once('ready-to-show', () => portWindow.show());
}

// ── App lifecycle ──

app.dock?.hide();

// Prevent app from quitting when all windows close — we're a tray app
app.on('before-quit', () => {
  app.isQuitting = true;
});

app.whenReady().then(async () => {
  const config = loadConfig();
  const port = config.port || 50515;
  await startServer(port);
  createTray();

  if (isFirstLaunch()) {
    showWizard();
  }
});

app.on('window-all-closed', () => {
  // Don't quit — we're a menu bar app, keep running with no windows
});

// Expose functions for renderer
global.mptApi = {
  listPrinters,
  getPort: () => PORT,
  saveConfig,
  loadConfig,
  isFirstLaunch,
  copyToClipboard: (text) => clipboard.writeText(text),
  openExternal: (url) => shell.openExternal(url),
  quit: () => app.quit(),
  setPort: (newPort) => {
    const config = loadConfig();
    config.port = newPort;
    saveConfig(config);
    // Restart the app to pick up the new port
    app.relaunch();
    app.quit();
  },
  installLaunchAgent: () => {
    const plistSrc = path.join(__dirname, 'com.mainchain.mpt.plist');
    const plistDest = path.join(app.getPath('home'), 'Library', 'LaunchAgents', 'com.mainchain.mpt.plist');
    try {
      // Update plist with actual paths
      let plist = fs.readFileSync(plistSrc, 'utf-8');
      const nodePath = process.execPath.includes('Electron')
        ? '/usr/local/bin/node'
        : process.execPath;
      plist = plist.replace(/<string>\/usr\/local\/bin\/node<\/string>/, `<string>${nodePath}</string>`);
      plist = plist.replace(/<string>\/Users\/george\/mpt-mac<\/string>/, `<string>${__dirname}</string>`);
      fs.writeFileSync(plistDest, plist);
      require('child_process').execSync(`launchctl load "${plistDest}"`);
      return true;
    } catch (e) {
      console.error('Failed to install LaunchAgent:', e.message);
      return false;
    }
  }
};
