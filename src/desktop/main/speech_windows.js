const { ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CULTURE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const POWERSHELL_EXE = path.join(process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SCRIPT_FILE = path.join(__dirname, 'speech_windows.ps1');

let scriptSource = '';

let session = null;

function isSupportedPlatform() {
  return fs.existsSync(POWERSHELL_EXE);
}

function readScriptSource() {
  if (!scriptSource) scriptSource = fs.readFileSync(SCRIPT_FILE, 'utf8');
  return scriptSource;
}

function buildEncodedCommand(mode, culture) {
  const injected = `$mode = '${mode}'\n$culture = '${culture}'\n`;
  return Buffer.from(injected + readScriptSource(), 'utf16le').toString('base64');
}

function spawnHelper(mode, culture) {
  const child = spawn(POWERSHELL_EXE, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', buildEncodedCommand(mode, culture)
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  const lines = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop();
    parts.forEach((line) => {
      const text = line.trim();
      if (text) lines.push(text);
    });
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.warn(`[WARN] [Speech] 子进程输出: ${text.split(/\r?\n/)[0]}`);
  });

  return { child, lines };
}

function parseLine(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    console.warn(`[WARN] [Speech] 无法解析子进程输出: ${line.slice(0, 200)}`);
    return null;
  }
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function probeStatus() {
  return new Promise((resolve) => {
    if (!isSupportedPlatform()) {
      resolve({ supported: false, reason: 'platform', languages: [] });
      return;
    }

    const helper = spawnHelper('status', '');
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
      if (!helper.child.killed) helper.child.kill();
    };

    helper.child.on('error', (error) => {
      console.error('[ERROR] [Speech] 启动探测进程失败:', error);
      finish({ supported: false, reason: 'spawn', languages: [] });
    });
    helper.child.on('close', () => {
      const statusLine = helper.lines.map(parseLine).find((item) => item && item.type === 'status');
      if (!statusLine) {
        finish({ supported: false, reason: 'probe', languages: [] });
        return;
      }
      finish({
        supported: true,
        systemCulture: statusLine.systemCulture || '',
        languages: toArray(statusLine.engines)
          .filter((engine) => engine && CULTURE_PATTERN.test(String(engine.culture || '')))
          .map((engine) => ({
            culture: String(engine.culture),
            id: String(engine.id || ''),
            description: String(engine.description || '')
          }))
      });
    });
  });
}

function sendToRenderer(payload) {
  if (!session || !session.sender || session.sender.isDestroyed()) return;
  session.sender.send('speech:event', payload);
}

function teardownSession(options = {}) {
  const current = session;
  session = null;
  if (!current) return;
  if (current.child && !current.child.killed) current.child.kill();
  if (!options.silent && current.sender && !current.sender.isDestroyed()) {
    current.sender.send('speech:event', options.payload || { type: 'closed' });
  }
}

function startSession(event, culture) {
  return new Promise((resolve) => {
    if (!isSupportedPlatform()) {
      resolve({ ok: false, code: 'Unsupported' });
      return;
    }
    if (session) {
      resolve({ ok: false, code: 'Busy' });
      return;
    }
    if (!CULTURE_PATTERN.test(culture)) {
      resolve({ ok: false, code: 'NoRecognizer', culture });
      return;
    }

    const helper = spawnHelper('listen', culture);
    const sender = event.sender;
    session = { child: helper.child, sender, lines: helper.lines, lastError: null, settled: false };

    const settle = (result) => {
      if (!session || session.settled) return;
      session.settled = true;
      resolve(result);
    };

    sender.once('destroyed', () => {

      if (session && session.sender === sender) teardownSession({ silent: true });
    });

    helper.child.on('error', (error) => {
      console.error('[ERROR] [Speech] 启动识别进程失败:', error);
      settle({ ok: false, code: 'Engine', message: error.message });
      teardownSession({ silent: true });
    });

const pump = setInterval(() => {
      if (!session || session.child !== helper.child) {
        clearInterval(pump);
        return;
      }
      while (helper.lines.length) {
        const item = parseLine(helper.lines.shift());
        if (!item || item.type === 'status') continue;
        if (item.type === 'ready') {
          settle({ ok: true, engine: item.engine || '', culture: item.culture || culture });
          continue;
        }
        if (item.type === 'error') {
          session.lastError = { code: item.code, message: item.message };
          settle({ ok: false, code: item.code || 'Engine', message: item.message || '', culture });
          continue;
        }
        sendToRenderer({
          type: item.type,
          text: typeof item.text === 'string' ? item.text : '',
          confidence: typeof item.confidence === 'number' ? item.confidence : undefined
        });
      }
    }, 40);

    helper.child.on('close', (code) => {
      clearInterval(pump);
      const lastError = session ? session.lastError : null;
      settle(lastError
        ? { ok: false, code: lastError.code || 'Engine', message: lastError.message || '', culture }
        : { ok: false, code: 'Engine', message: `识别进程已退出（代码 ${code}）`, culture });
      teardownSession({ payload: { type: 'closed', code: lastError && lastError.code } });
    });
  });
}

function stopSession() {
  if (!session) return { ok: true, stopped: false };

  teardownSession({ silent: true });
  return { ok: true, stopped: true };
}

function registerSpeechIpc() {
  ipcMain.handle('speech:status', () => probeStatus());
  ipcMain.handle('speech:start', (event, options = {}) => {
    const culture = typeof options.culture === 'string' ? options.culture.trim() : '';
    return startSession(event, culture);
  });
  ipcMain.handle('speech:stop', () => stopSession());
}

function disposeSpeechWindows() {
  if (session) teardownSession({ silent: true });
}

module.exports = {
  disposeSpeechWindows,
  isSpeechSupported: isSupportedPlatform,
  probeSpeechStatus: probeStatus,
  registerSpeechIpc
};
