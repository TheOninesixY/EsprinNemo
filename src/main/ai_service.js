// AI 助手（主进程）：代理兼容 OpenAI 协议的对话与模型列表请求。
// 渲染进程只提交消息内容，API 站点 / KEY / 模型等敏感配置由主进程自行从数据目录的 config.json 读取，
// 密钥因此不会经由 IPC 往返、也不会出现在页面脚本里；同时也避开了 file:// 页面直接请求外部接口的跨域限制。
const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

// 对话请求默认超时：流式生成可能很慢，给足 3 分钟；模型列表与连接测试属于轻量请求，30 秒足够
const CHAT_TIMEOUT_MS = 180000;
const SIMPLE_TIMEOUT_MS = 30000;

// 这些字段由渲染进程在提问时按需覆盖（用于「测试连接」复用同一套请求逻辑）
const MAX_MESSAGES = 64;
const MAX_MESSAGE_CHARS = 200000;

let resolveDataDir = null;
let ipcRegistered = false;

// requestId -> { controller, aborted }
const activeRequests = new Map();

// 由 main.js 注入数据目录解析器（AI 配置与笔记一起放在用户数据目录中）
function configureAiService({ getDataDir } = {}) {
  if (typeof getDataDir === 'function') resolveDataDir = getDataDir;
}

// 读取 AI 配置：只取接口相关三项，其余（默认上下文范围等）由渲染进程自行处理
function readAiSettings() {
  const fallback = { baseUrl: '', apiKey: '', model: '' };
  try {
    if (!resolveDataDir) return fallback;
    const configFile = path.join(resolveDataDir(), 'config.json');
    if (!fs.existsSync(configFile)) return fallback;
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const ai = config && typeof config === 'object' && config.ai && typeof config.ai === 'object' ? config.ai : {};
    return {
      baseUrl: typeof ai.baseUrl === 'string' ? ai.baseUrl.trim() : '',
      apiKey: typeof ai.apiKey === 'string' ? ai.apiKey.trim() : '',
      model: typeof ai.model === 'string' ? ai.model.trim() : ''
    };
  } catch (error) {
    console.error('[Esprin Nemo] 读取 AI 配置失败:', error);
    return fallback;
  }
}

// 用户填写的是「API 站点」，可能带 /v1、也可能直接是完整的 /chat/completions 端点，这里统一折算为完整 URL
function buildEndpoint(baseUrl, suffix) {
  let base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';

  if (/\/chat\/completions$/i.test(base)) {
    if (suffix === 'chat/completions') return base;
    base = base.replace(/\/chat\/completions$/i, '');
  }
  // 已经写到版本号一级（如 https://api.openai.com/v1）时直接拼接
  if (/\/v\d+[a-z]*$/i.test(base)) return `${base}/${suffix}`;
  return `${base}/v1/${suffix}`;
}

function authHeaders(settings) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json'
  };
  // 本地服务（Ollama 等）无需鉴权，留空时不发 Authorization 头
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  return headers;
}

// 从服务端返回的报错正文里挑一句可读的原因，尽量贴近用户能理解的说法
function extractErrorDetail(body) {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body);
    const message = parsed && parsed.error && (parsed.error.message || parsed.error.type);
    if (typeof message === 'string' && message.trim()) return message.trim();
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim();
  } catch (error) {
    // 非 JSON 正文，退化为截断的原始文本
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
  raw.slice(0, MAX_MESSAGES).forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const role = item.role === 'assistant' || item.role === 'system' ? item.role : 'user';
    const content = typeof item.content === 'string' ? item.content.slice(0, MAX_MESSAGE_CHARS) : '';
    if (!content.trim()) return;
    list.push({ role, content });
  });
  return list;
}

function sendChunk(sender, requestId, delta) {
  if (!requestId || !sender || sender.isDestroyed()) return;
  try {
    sender.send('ai:stream', { requestId, delta });
  } catch (error) {
    // 窗口已关闭等情况直接忽略，最终结果照样通过 invoke 返回
  }
}

// 解析 SSE 流：逐行取 data: 负载，累计 choices[0].delta.content
async function consumeStream(response, sender, requestId, state) {
  const contentType = String(response.headers.get('content-type') || '');
  // 少数服务端会忽略 stream: true 而直接返回完整 JSON，这里一并兜住
  if (!/text\/event-stream/i.test(contentType)) {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      const content = parsed && parsed.choices && parsed.choices[0]
        ? (parsed.choices[0].message && parsed.choices[0].message.content) || ''
        : '';
      if (content) {
        state.content += content;
        sendChunk(sender, requestId, content);
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
    // 最后一行可能是被截断的半条数据，留到下一轮再拼
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
        continue; // 忽略心跳等无法解析的片段
      }

      const choice = parsed && Array.isArray(parsed.choices) ? parsed.choices[0] : null;
      if (!choice) continue;
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

async function runChat({ messages, sender, requestId, stream }) {
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
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: authHeaders(settings),
      body: JSON.stringify({ model: settings.model, messages, stream: !!stream }),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ok: false, error: describeHttpError(response.status, body) };
    }

    const state = { content: '' };
    if (stream) {
      await consumeStream(response, sender, requestId, state);
      if (!state.content) return { ok: false, error: 'AI 没有返回任何内容，请检查模型名称是否可用' };
      return { ok: true, content: state.content };
    }

    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { ok: false, error: 'AI 返回内容无法解析，可能不是兼容 OpenAI 协议的接口' };
    }
    const content = parsed && parsed.choices && parsed.choices[0]
      ? (parsed.choices[0].message && parsed.choices[0].message.content) || ''
      : '';
    if (!content) return { ok: false, error: 'AI 没有返回任何内容，请检查模型名称是否可用' };
    return { ok: true, content };
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

  // 流式对话：增量通过 ai:stream 事件推送，最终结果由 invoke 的返回值给出
  ipcMain.handle('ai:chat', async (event, payload) => {
    const requestId = payload && typeof payload.requestId === 'string' ? payload.requestId : '';
    const messages = normalizeMessages(payload && payload.messages);
    if (!messages.length) return { ok: false, error: '没有可发送的内容' };
    return runChat({ messages, sender: event.sender, requestId, stream: true });
  });

  // 中止生成：仅对当前 requestId 生效
  ipcMain.handle('ai:abort', (event, payload) => {
    const requestId = payload && typeof payload.requestId === 'string' ? payload.requestId : '';
    const entry = requestId ? activeRequests.get(requestId) : null;
    if (!entry) return { ok: false };
    entry.aborted = true;
    try {
      entry.controller.abort();
    } catch (error) {
      // 忽略
    }
    return { ok: true };
  });

  // 拉取模型列表：GET {base}/models，用于填充模型下拉建议
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

  // 连接测试：发送一条最短的对话请求，验证站点 / KEY / 模型三者是否可用
  ipcMain.handle('ai:test', async () => {
    const result = await runChat({
      messages: [
        { role: 'system', content: '你是连接测试助手，只需回复两个字：可用。' },
        { role: 'user', content: '连接测试' }
      ],
      sender: null,
      requestId: '',
      stream: false
    });
    return result;
  });
}

module.exports = { configureAiService, registerAiIpc };
