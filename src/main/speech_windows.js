// 随口记的系统语音识别桥（主进程）。
//
// 识别由 Windows 自带的桌面识别引擎完成（System.Speech.Recognition.SpeechRecognitionEngine +
// DictationGrammar），音频只进本机引擎、不出本机，因此渲染进程既不碰麦克风，也不经过网络。
// 引擎跑在一个 Windows PowerShell 子进程里（见 speech_windows.ps1），结果按行以 JSON 回传，
// 这里再转成 IPC 事件交给渲染进程。
//
// 子进程生命周期与会话一一对应：渲染进程 start 时拉起，stop 或窗口销毁时结束；
// 应用退出前也会收掉，避免留下一个仍然占着麦克风的进程。
const { ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 只认这几个取值，避免把渲染进程传来的字符串拼进脚本
const CULTURE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
// Windows PowerShell 5.1 的固定位置：WinRT / System.Speech 在 pwsh（.NET Core）里不可用
const POWERSHELL_EXE = path.join(process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SCRIPT_FILE = path.join(__dirname, 'speech_windows.ps1');

// 脚本内容只读一次；执行时以 UTF-16LE base64 经 -EncodedCommand 交给 PowerShell：
// 不落临时文件，也不受命令行引号与控制台代码页影响（见 speech_windows.ps1 头部说明）
let scriptSource = '';
// 当前会话：{ child, sender, lastError, settled }
let session = null;

function isSupportedPlatform() {
  return process.platform === 'win32' && fs.existsSync(POWERSHELL_EXE);
}

function readScriptSource() {
  if (!scriptSource) scriptSource = fs.readFileSync(SCRIPT_FILE, 'utf8');
  return scriptSource;
}

function buildEncodedCommand(mode, culture) {
  const injected = `$mode = '${mode}'\n$culture = '${culture}'\n`;
  return Buffer.from(injected + readScriptSource(), 'utf16le').toString('base64');
}

// 起一个 PowerShell 子进程：-EncodedCommand 承载整段脚本，额外参数都靠脚本内注入的变量传递
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
  // PowerShell 的报错文本只作诊断留在主进程日志里，不往界面上抛
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.warn(`[WARN] [Speech] 子进程输出: ${text.split(/\r?\n/)[0]}`);
  });

  return { child, lines };
}

// JSON 行解析：解析失败的行走 console，不让它影响会话
function parseLine(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    console.warn(`[WARN] [Speech] 无法解析子进程输出: ${line.slice(0, 200)}`);
    return null;
  }
}

// 单元素数组会被 ConvertTo-Json 折成对象，这里统一成数组
function toArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

// 探测本机可用的识别引擎（设置页的状态行用）
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

// 会话结束后的统一收尾：通知界面、清掉引用（silent 用于渲染进程自己发起的 stop）
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
      // 窗口没了就没有接收方，会话不必继续占着麦克风
      if (session && session.sender === sender) teardownSession({ silent: true });
    });

    helper.child.on('error', (error) => {
      console.error('[ERROR] [Speech] 启动识别进程失败:', error);
      settle({ ok: false, code: 'Engine', message: error.message });
      teardownSession({ silent: true });
    });

    // 结果行是流式的：子进程按行写入，这里定时取走并转成界面事件
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
  // silent：停止是渲染进程主动发起的，不需要再回一条「会话已结束」
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

// 退出前收掉子进程：否则系统里会留下一个仍占着麦克风的 PowerShell
function disposeSpeechWindows() {
  if (session) teardownSession({ silent: true });
}

module.exports = {
  disposeSpeechWindows,
  isSpeechSupported: isSupportedPlatform,
  probeSpeechStatus: probeStatus,
  registerSpeechIpc
};
