const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const POWERSHELL_EXE = path.join(process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SCRIPT_FILE = path.join(__dirname, 'desktop_layer.ps1');

const MAX_RESTARTS = 3;

const QUIT_GRACE_MS = 400;

let scriptSource = '';
let child = null;
let restarts = 0;
let unavailable = false;
let closing = false;

function isSupportedPlatform() {
  return fs.existsSync(POWERSHELL_EXE);
}

function buildEncodedCommand() {
  if (!scriptSource) scriptSource = fs.readFileSync(SCRIPT_FILE, 'utf8');
  return Buffer.from(scriptSource, 'utf16le').toString('base64');
}

function windowHandle(win) {
  try {
    const buffer = win.getNativeWindowHandle();
    if (!buffer || !buffer.length) return '';
    return buffer.length >= 8 ? buffer.readBigUInt64LE(0).toString() : String(buffer.readUInt32LE(0));
  } catch (error) {
    return '';
  }
}

function spawnHelper() {
  const process_ = spawn(POWERSHELL_EXE, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', buildEncodedCommand()
  ], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });

process_.stderr.setEncoding('utf8');
  process_.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.warn(`[WARN] [DesktopLayer] ${text.split(/\r?\n/)[0]}`);
  });

process_.stdin.on('error', () => {});

  process_.on('error', (error) => {
    console.warn('[WARN] [DesktopLayer] 子进程启动失败，便利贴退回普通窗口层级:', error.message);
    unavailable = true;
    child = null;
  });

  process_.on('exit', (code) => {
    if (child === process_) child = null;
    if (closing || unavailable) return;

    restarts++;
    if (restarts >= MAX_RESTARTS) {
      unavailable = true;
      console.warn(`[WARN] [DesktopLayer] 子进程已退出 ${restarts} 次，停用置底 (code=${code})`);
      return;
    }
    console.warn(`[WARN] [DesktopLayer] 子进程退出，下次请求时重启 (code=${code})`);
  });

  return process_;
}

function ensureChild() {
  if (unavailable) return null;
  if (child && child.exitCode === null && !child.killed) return child;

  if (!isSupportedPlatform()) {
    unavailable = true;
    console.warn('[WARN] [DesktopLayer] 当前平台没有可用的 Windows PowerShell，停用置底');
    return null;
  }

  try {
    child = spawnHelper();
    return child;
  } catch (error) {
    unavailable = true;
    console.warn('[WARN] [DesktopLayer] 启动子进程失败，便利贴退回普通窗口层级:', error);
    return null;
  }
}

function setDesktopLevel(win) {
  if (unavailable || !win || win.isDestroyed()) return false;

  const handle = windowHandle(win);
  if (!handle) return false;

  const helper = ensureChild();
  if (!helper || !helper.stdin || helper.stdin.destroyed) return false;

  try {
    helper.stdin.write(`${handle}\n`);
    return true;
  } catch (error) {
    console.warn('[WARN] [DesktopLayer] 写入置底请求失败:', error.message);
    return false;
  }
}

function raiseAboveDesktop(win) {
  if (!win || win.isDestroyed()) return;
  if (!isSupportedPlatform()) return;
  try {
    win.moveTop();
  } catch (error) {

  }
}

function keepDesktopLevel(win) {
  if (!win || win.isDestroyed()) return;
  if (!isSupportedPlatform()) return;

  const pushDown = () => {
    if (win.isDestroyed()) return;
    setDesktopLevel(win);
  };

  win.on('show', pushDown);
  win.on('restore', pushDown);
  win.on('blur', pushDown);
  win.on('minimize', () => {
    if (win.isDestroyed()) return;
    win.restore();
    pushDown();
  });
}

function disposeDesktopLayer() {
  closing = true;
  const current = child;
  child = null;
  if (!current || current.exitCode !== null) return;

  try {
    current.stdin.write('quit\n');
  } catch (error) {

  }

  const timer = setTimeout(() => {
    if (current.exitCode === null) {
      try {
        current.kill();
      } catch (error) {

      }
    }
  }, QUIT_GRACE_MS);
  if (typeof timer.unref === 'function') timer.unref();
  current.once('exit', () => clearTimeout(timer));
}

module.exports = {
  disposeDesktopLayer,
  isDesktopLayerSupported: isSupportedPlatform,
  keepDesktopLevel,
  raiseAboveDesktop,
  setDesktopLevel
};
