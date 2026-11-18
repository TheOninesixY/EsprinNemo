const { ipcMain, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { adoptLegacyApiKey, keyStatus, readApiKey, writeApiKey } = require('./ai_secret.js');

const CHAT_TIMEOUT_MS = 180000;
const SIMPLE_TIMEOUT_MS = 30000;

const MAX_MESSAGES = 64;
const MAX_MESSAGE_CHARS = 200000;

const MAX_TOOLS = 32;
const MAX_TOOL_SCHEMA_CHARS = 20000;

const AI_FILES_DIR = 'ai_files';
const AI_ATTACHMENT_NAME_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_TEXT_CHARS = 200000;

const MAX_IMAGES_PER_REQUEST = 6;
const MAX_IMAGE_BYTES_PER_REQUEST = 20 * 1024 * 1024;
const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
};

const TEXT_FILE_EXTENSIONS = [
  'md', 'markdown', 'txt', 'text', 'log', 'json', 'jsonl', 'csv', 'tsv', 'yml', 'yaml', 'xml',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'html', 'htm', 'vue', 'svelte',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bat', 'ps1', 'sql'
];

let resolveDataDir = null;
let ipcRegistered = false;

const activeRequests = new Map();

function configureAiService({ getDataDir } = {}) {
  if (typeof getDataDir === 'function') resolveDataDir = getDataDir;
}

function readAiSettings() {
  const settings = { baseUrl: '', apiKey: '', model: '' };
  if (!resolveDataDir) return settings;

  const configFile = path.join(resolveDataDir(), 'config.json');
  let config = null;
  try {
    if (fs.existsSync(configFile)) config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (error) {
    console.error('[Esprin Nemo] 读取 AI 配置失败:', error);
  }

  const ai = config && typeof config === 'object' && config.ai && typeof config.ai === 'object' ? config.ai : {};
  settings.baseUrl = typeof ai.baseUrl === 'string' ? ai.baseUrl.trim() : '';
  settings.model = typeof ai.model === 'string' ? ai.model.trim() : '';
  settings.apiKey = readApiKey() || adoptLegacyApiKey(config, configFile);
  return settings;
}

function buildEndpoint(baseUrl, suffix) {
  let base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';

  if (/\/chat\/completions$/i.test(base)) {
    if (suffix === 'chat/completions') return base;
    base = base.replace(/\/chat\/completions$/i, '');
  }

  if (/\/v\d+[a-z]*$/i.test(base)) return `${base}/${suffix}`;
  return `${base}/v1/${suffix}`;
}

function authHeaders(settings) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json'
  };

  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  return headers;
}

function extractErrorDetail(body) {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body);
    const message = parsed && parsed.error && (parsed.error.message || parsed.error.type);
    if (typeof message === 'string' && message.trim()) return message.trim();
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim();
  } catch (error) {

  }
  return String(body).replace(/\s+/g, ' ').trim().slice(0, 200);
}

function describeHttpError(status, body) {
  let reason;
  if (status === 401 || status === 403) reason = 'API Key 无效或没有访问权限';
  else if (status === 404) reason = '接口地址不存在，请检查 API 站点是否填写正确';
  else if (status === 429) reason = '请求过于频繁或额度不足，请稍后重试';
  else if (status >= 500) reason = 'AI 服务端返回错误';
  else reason = `请求失败（HTTP ${status}）`;

  const detail = extractErrorDetail(body);
  return detail ? `${reason}：${detail}` : reason;
}

function describeNetworkError(error) {
  const message = error && error.message ? String(error.message) : '';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return '无法解析 API 站点域名，请检查站点地址与网络';
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message)) return '无法连接到 API 站点，请确认服务是否可用';
  if (/certificate|SSL|TLS/i.test(message)) return 'TLS 证书校验失败，请检查站点地址';
  return message ? `请求失败：${message}` : '请求失败：无法连接到 API 站点';
}

function normalizeMessages(raw) {
  const list = [];
  if (!Array.isArray(raw)) return list;

  const imageBudget = { count: 0, bytes: 0 };

  raw.slice(0, MAX_MESSAGES).forEach((item) => {
    if (!item || typeof item !== 'object') return;

if (item.role === 'tool') {
      const toolCallId = typeof item.tool_call_id === 'string' ? item.tool_call_id.trim() : '';
      if (!toolCallId) return;
      const content = typeof item.content === 'string' ? item.content.slice(0, MAX_MESSAGE_CHARS) : '';
      list.push({ role: 'tool', tool_call_id: toolCallId, content });
      return;
    }

    const role = item.role === 'assistant' || item.role === 'system' ? item.role : 'user';
    const content = typeof item.content === 'string' ? item.content.slice(0, MAX_MESSAGE_CHARS) : '';
    const toolCalls = normalizeToolCalls(item.tool_calls);
    const images = role === 'user' ? sanitizeImageRefs(item.images) : [];

if (!content.trim() && !toolCalls.length && !images.length) return;

    const message = { role, content };
    if (toolCalls.length) message.tool_calls = toolCalls;
    if (images.length) message.content = inlineImages(content, images, imageBudget);
    list.push(message);
  });

  return list;
}

function inlineImages(text, images, budget) {
  const parts = [];
  if (text.trim()) parts.push({ type: 'text', text });
  let skipped = 0;

  images.forEach((ref) => {
    if (budget.count >= MAX_IMAGES_PER_REQUEST || budget.bytes >= MAX_IMAGE_BYTES_PER_REQUEST) {
      skipped++;
      return;
    }
    let buffer = null;
    try {
      buffer = fs.readFileSync(ref.path);
    } catch (error) {
      skipped++;
      return;
    }
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
      skipped++;
      return;
    }
    budget.count += 1;
    budget.bytes += buffer.length;
    const mime = ref.mime || imageMimeFor(ref.name || ref.path) || 'image/png';
    parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } });
  });

  if (skipped > 0) {
    parts.push({ type: 'text', text: `（有 ${skipped} 张图片因过多或过大未随本次请求发送）` });
  }

  return parts.length ? parts : text;
}

function normalizeToolCalls(raw) {
  if (!Array.isArray(raw)) return [];
  const calls = [];
  raw.slice(0, MAX_TOOLS).forEach((item) => {
    const fn = item && item.function ? item.function : null;
    const name = fn && typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name) return;
    calls.push({
      id: typeof item.id === 'string' && item.id ? item.id : `call_${name}`,
      type: 'function',
      function: {
        name,
        arguments: typeof fn.arguments === 'string' ? fn.arguments.slice(0, MAX_TOOL_SCHEMA_CHARS) : '{}'
      }
    });
  });
  return calls;
}

function normalizeTools(raw) {
  if (!Array.isArray(raw)) return [];
  const tools = [];
  raw.slice(0, MAX_TOOLS).forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const fn = item.function;
    if (!fn || typeof fn.name !== 'string' || !fn.name.trim()) return;
    try {
      const serialized = JSON.stringify(item);
      if (serialized.length > MAX_TOOL_SCHEMA_CHARS) return;
    } catch (error) {
      return;
    }
    tools.push(item);
  });
  return tools;
}

function aiFilesDir() {
  return path.join(resolveDataDir ? resolveDataDir() : process.cwd(), AI_FILES_DIR);
}

function ensureAiFilesDir() {
  const dir = aiFilesDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    console.error('[Esprin Nemo] 创建 AI 附件目录失败:', error);
  }
  return dir;
}

function imageMimeFor(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] || '';
}

function isTextBuffer(buffer) {

  return buffer.subarray(0, 8000).indexOf(0) === -1;
}

function attachmentId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function storedFileName(originalName) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  const safeExt = /^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext : '';
  return `${attachmentId()}${safeExt}`;
}

function storeAttachment(buffer, originalName) {
  const dir = ensureAiFilesDir();
  const file = storedFileName(originalName);
  fs.writeFileSync(path.join(dir, file), buffer);
  return file;
}

function describeAttachment({ name, size, buffer, storedFile }) {
  const displayName = String(name || '未命名文件');
  const mime = imageMimeFor(displayName);

  if (mime) {
    if (size > MAX_IMAGE_BYTES) {
      return { error: `${displayName} 超过单张图片 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB 的上限` };
    }
    const file = storedFile || storeAttachment(buffer, displayName);
    return { attachment: { id: attachmentId(), kind: 'image', name: displayName, size, mime, file } };
  }

  if (size > MAX_TEXT_BYTES) {
    return { error: `${displayName} 超过文本附件 ${Math.round(MAX_TEXT_BYTES / 1024)} KB 的上限` };
  }
  if (!isTextBuffer(buffer)) {
    return { error: `${displayName} 不是可读的文本或图片文件` };
  }

  const text = buffer.toString('utf8');
  const truncated = text.length > MAX_TEXT_CHARS;
  return {
    attachment: {
      id: attachmentId(),
      kind: 'text',
      name: displayName,
      size,
      content: truncated ? `${text.slice(0, MAX_TEXT_CHARS)}\n…（文件过长，已截断）` : text
    }
  };
}

function importAttachmentFromPath(sourcePath) {
  try {
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) return { error: `${path.basename(sourcePath)} 不是文件` };
    const buffer = fs.readFileSync(sourcePath);
    const name = path.basename(sourcePath);
    const mime = imageMimeFor(name);

    return describeAttachment({
      name,
      size: buffer.length,
      buffer,
      storedFile: mime ? storeAttachment(buffer, name) : ''
    });
  } catch (error) {
    return { error: `读取 ${path.basename(sourcePath)} 失败：${error.message}` };
  }
}

function importAttachmentFromBytes(raw) {
  if (!raw || typeof raw !== 'object') return { error: '附件内容无效' };
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '粘贴的图片.png';
  let buffer = null;
  try {
    if (raw.data instanceof Uint8Array) buffer = Buffer.from(raw.data);
    else if (raw.data instanceof ArrayBuffer) buffer = Buffer.from(new Uint8Array(raw.data));
    else if (raw.data && raw.data.type === 'Buffer' && Array.isArray(raw.data.data)) buffer = Buffer.from(raw.data.data);
  } catch (error) {
    return { error: `解析 ${name} 失败：${error.message}` };
  }
  if (!buffer || !buffer.length) return { error: `${name} 内容为空` };

  const mime = imageMimeFor(name) || (typeof raw.mime === 'string' && /^image\//.test(raw.mime) && raw.mime) || '';
  return describeAttachment({
    name,
    size: buffer.length,
    buffer,
    storedFile: mime ? storeAttachment(buffer, name) : ''
  });
}

function sanitizeImageRefs(raw) {
  if (!Array.isArray(raw)) return [];
  const refs = [];
  raw.slice(0, MAX_IMAGES_PER_REQUEST).forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const filePath = typeof item.path === 'string' ? item.path.trim() : '';
    if (!filePath) return;
    refs.push({
      path: filePath,
      name: typeof item.name === 'string' ? item.name : '',
      mime: typeof item.mime === 'string' ? item.mime : ''
    });
  });
  return refs;
}

function sendChunk(sender, requestId, delta) {
  if (!requestId || !sender || sender.isDestroyed()) return;
  try {
    sender.send('ai:stream', { requestId, delta });
  } catch (error) {

  }
}

function applyToolCallDelta(state, deltas) {
  if (!Array.isArray(deltas)) return;
  deltas.forEach((delta) => {
    if (!delta || typeof delta !== 'object') return;
    const index = Number.isInteger(delta.index) ? delta.index : 0;
    if (!state.toolCalls[index]) state.toolCalls[index] = { id: '', name: '', arguments: '' };
    const entry = state.toolCalls[index];
    if (typeof delta.id === 'string' && delta.id) entry.id = delta.id;
    const fn = delta.function;
    if (!fn) return;
    if (typeof fn.name === 'string') entry.name += fn.name;
    if (typeof fn.arguments === 'string') entry.arguments += fn.arguments;
  });
}

function finalizeToolCalls(state) {
  return state.toolCalls
    .filter(entry => entry && entry.name)
    .map((entry, index) => ({
      id: entry.id || `call_${entry.name}_${index}`,
      name: entry.name,
      arguments: entry.arguments || '{}'
    }));
}

async function consumeStream(response, sender, requestId, state) {
  const contentType = String(response.headers.get('content-type') || '');

  if (!/text\/event-stream/i.test(contentType)) {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      const choice = parsed && parsed.choices ? parsed.choices[0] : null;
      const message = choice && choice.message ? choice.message : null;
      const content = (message && message.content) || '';
      if (content) {
        state.content += content;
        sendChunk(sender, requestId, content);
      }
      if (message && Array.isArray(message.tool_calls)) {
        state.toolCalls = message.tool_calls.map((item, index) => ({
          id: item.id || `call_${index}`,
          name: item.function && item.function.name ? item.function.name : '',
          arguments: item.function && item.function.arguments ? item.function.arguments : '{}'
        })).filter(item => item.name);
      }
      return state.content;
    } catch (error) {
      throw new Error('AI 返回内容无法解析，可能不是兼容 OpenAI 协议的接口');
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);

    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return state.content;

      let parsed = null;
      try {
        parsed = JSON.parse(payload);
      } catch (error) {
        continue;
      }

      const choice = parsed && Array.isArray(parsed.choices) ? parsed.choices[0] : null;
      if (!choice) continue;
      if (choice.delta && choice.delta.tool_calls) applyToolCallDelta(state, choice.delta.tool_calls);
      const delta = choice.delta
        ? (choice.delta.content || '')
        : (choice.message && choice.message.content) || '';
      if (!delta) continue;

      state.content += delta;
      sendChunk(sender, requestId, delta);
    }
  }

  return state.content;
}

async function runChat({ messages, sender, requestId, stream, tools }) {
  const settings = readAiSettings();
  if (!settings.baseUrl) return { ok: false, error: '尚未配置 API 站点，请在「设置 → AI 助手」中填写' };
  if (!settings.model) return { ok: false, error: '尚未选择模型，请在「设置 → AI 助手」中填写' };

  const endpoint = buildEndpoint(settings.baseUrl, 'chat/completions');
  const controller = new AbortController();
  const entry = { controller, aborted: false };
  if (requestId) activeRequests.set(requestId, entry);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CHAT_TIMEOUT_MS);

  try {
    const body = { model: settings.model, messages, stream: !!stream };

    if (tools.length) body.tools = tools;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: authHeaders(settings),
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const responseBody = await response.text().catch(() => '');
      return { ok: false, error: describeHttpError(response.status, responseBody) };
    }

    const state = { content: '', toolCalls: [] };
    if (stream) {
      await consumeStream(response, sender, requestId, state);
      const toolCalls = finalizeToolCalls(state);

      if (!state.content && !toolCalls.length) {
        return { ok: false, error: 'AI 没有返回任何内容，请检查模型名称是否可用' };
      }
      return { ok: true, content: state.content, toolCalls };
    }

    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { ok: false, error: 'AI 返回内容无法解析，可能不是兼容 OpenAI 协议的接口' };
    }
    const choice = parsed && Array.isArray(parsed.choices) ? parsed.choices[0] : null;
    const message = choice && choice.message ? choice.message : null;
    const content = (message && message.content) || '';
    const toolCalls = message && Array.isArray(message.tool_calls)
      ? message.tool_calls.map((item, index) => ({
        id: item.id || `call_${index}`,
        name: item.function && item.function.name ? item.function.name : '',
        arguments: item.function && item.function.arguments ? item.function.arguments : '{}'
      })).filter(item => item.name)
      : [];

    if (!content && !toolCalls.length) {
      return { ok: false, error: 'AI 没有返回任何内容，请检查模型名称是否可用' };
    }
    return { ok: true, content, toolCalls };
  } catch (error) {
    if (entry.aborted) return { ok: false, error: '已停止生成', canceled: true };
    if (timedOut) return { ok: false, error: `请求超时（超过 ${Math.round(CHAT_TIMEOUT_MS / 1000)} 秒），请检查站点或稍后重试` };
    return { ok: false, error: describeNetworkError(error) };
  } finally {
    clearTimeout(timer);
    if (requestId) activeRequests.delete(requestId);
  }
}

function registerAiIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

ipcMain.handle('ai:key-status', () => keyStatus());

ipcMain.handle('ai:set-key', (event, payload) => {
    const apiKey = payload && typeof payload.apiKey === 'string' ? payload.apiKey : '';
    return writeApiKey(apiKey);
  });

ipcMain.on('ai:set-key-sync', (event, payload) => {
    const apiKey = payload && typeof payload.apiKey === 'string' ? payload.apiKey : '';
    event.returnValue = writeApiKey(apiKey);
  });

  ipcMain.on('ai:key-status-sync', (event) => {
    event.returnValue = keyStatus();
  });

ipcMain.handle('ai:chat', async (event, payload) => {
    const requestId = payload && typeof payload.requestId === 'string' ? payload.requestId : '';
    const messages = normalizeMessages(payload && payload.messages);
    if (!messages.length) return { ok: false, error: '没有可发送的内容' };
    const tools = normalizeTools(payload && payload.tools);
    return runChat({ messages, sender: event.sender, requestId, stream: true, tools });
  });

ipcMain.handle('ai:pick-attachments', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: '选择要发送给 AI 的文件',
      buttonLabel: '添加',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '图片与文本文件',
          extensions: [...Object.keys(IMAGE_MIME_BY_EXT).map(ext => ext.slice(1)), ...TEXT_FILE_EXTENSIONS]
        },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (result.canceled) return { canceled: true, paths: [] };
    return { canceled: false, paths: result.filePaths };
  });

ipcMain.handle('ai:import-attachments', (event, payload) => {
    const attachments = [];
    const errors = [];

    const paths = payload && Array.isArray(payload.paths) ? payload.paths.slice(0, MAX_IMAGES_PER_REQUEST * 2) : [];
    paths.forEach((item) => {
      const sourcePath = typeof item === 'string' ? item.trim() : '';
      if (!sourcePath) return;
      const outcome = importAttachmentFromPath(sourcePath);
      if (outcome.attachment) attachments.push(outcome.attachment);
      else if (outcome.error) errors.push(outcome.error);
    });

    const blobs = payload && Array.isArray(payload.blobs) ? payload.blobs.slice(0, MAX_IMAGES_PER_REQUEST * 2) : [];
    blobs.forEach((item) => {
      const outcome = importAttachmentFromBytes(item);
      if (outcome.attachment) attachments.push(outcome.attachment);
      else if (outcome.error) errors.push(outcome.error);
    });

    return { attachments, errors };
  });

ipcMain.handle('ai:delete-attachments', (event, payload) => {
    const files = payload && Array.isArray(payload.files) ? payload.files : [];
    const dir = aiFilesDir();
    let deleted = 0;
    files.forEach((item) => {
      const file = typeof item === 'string' ? item.trim() : '';
      if (!AI_ATTACHMENT_NAME_RE.test(file)) return;
      try {
        fs.unlinkSync(path.join(dir, file));
        deleted += 1;
      } catch (error) {

      }
    });
    return { deleted };
  });

ipcMain.handle('ai:abort', (event, payload) => {
    const requestId = payload && typeof payload.requestId === 'string' ? payload.requestId : '';
    const entry = requestId ? activeRequests.get(requestId) : null;
    if (!entry) return { ok: false };
    entry.aborted = true;
    try {
      entry.controller.abort();
    } catch (error) {

    }
    return { ok: true };
  });

ipcMain.handle('ai:models', async () => {
    const settings = readAiSettings();
    if (!settings.baseUrl) return { ok: false, error: '请先填写 API 站点' };

    const endpoint = buildEndpoint(settings.baseUrl, 'models');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SIMPLE_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: authHeaders(settings),
        signal: controller.signal
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return { ok: false, error: describeHttpError(response.status, body) };
      }
      const parsed = await response.json();
      const models = Array.isArray(parsed && parsed.data)
        ? parsed.data.map((item) => (item && typeof item.id === 'string' ? item.id : '')).filter(Boolean)
        : [];
      if (!models.length) return { ok: false, error: '该站点未返回模型列表，请手动填写模型名称' };
      return { ok: true, models: models.sort() };
    } catch (error) {
      return { ok: false, error: describeNetworkError(error) };
    } finally {
      clearTimeout(timer);
    }
  });

ipcMain.handle('ai:test', async () => {
    const result = await runChat({
      messages: [
        { role: 'system', content: '你是连接测试助手，只需回复两个字：可用。' },
        { role: 'user', content: '连接测试' }
      ],
      sender: null,
      requestId: '',
      stream: false,
      tools: []
    });
    return result;
  });
}

module.exports = { configureAiService, registerAiIpc };