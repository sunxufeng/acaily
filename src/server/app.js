import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { setConfig, getConfig, deleteConfig, listUsers } from '../config/userConfigStore.js';
import { createSession, appendMessage, getHistory, listSessions } from '../config/conversationStore.js';
import { Retriever } from '../rag/retriever.js';
import { EmbeddingService } from '../rag/embeddings.js';
import { record, query as queryAudit } from '../audit/auditLog.js';
import { track, snapshot as statsSnapshot } from '../admin/stats.js';
import { isAdmin, isAdminOpenId, ensureAdmin, listAdmins } from '../auth/rbac.js';
import {
  parseSession,
  setSessionCookie,
  clearSessionCookie,
  setOauthState,
  getOauthState,
  getFeishuAuthorizeUrl,
  exchangeCodeForToken,
  fetchFeishuUserInfo,
} from '../auth/session.js';
import { selfAssess } from '../compliance/checklist.js';
import { routeChat, testConnection, rateLimitRemaining } from '../gateway/router.js';
import { AgentRuntime } from '../agent/runtime.js';
import { parseEvent, verifySignature, extractMessage } from '../feishu/event.js';
import { sendText, sendMarkdown } from '../feishu/client.js';
import { startFeishuConnection, getFeishuWsStatus } from '../feishu/connection.js';
import { extractFeishuDocLinks, isReadableCloudDoc, fetchFeishuDoc } from '../feishu/docRead.js';
import { truncateExtracted } from '../feishu/fileExtract.js';
import { webTools } from '../tools/web.js';
import { feishuChatTools } from '../tools/feishuChat.js';

// 内置工具：时间 + 实时信息（天气 / 联网搜索）
const tools = [
  {
    name: 'get_time',
    description: '获取当前服务器时间，参数为空对象 {}',
    run: async () => new Date().toISOString(),
  },
  ...webTools,
  ...feishuChatTools,
];

const agent = new AgentRuntime({ tools });

// 知识库 RAG（T4）：共享检索器实例
const retriever = new Retriever(new EmbeddingService());

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

async function handleChat(openId, messages) {
  return routeChat(openId, messages);
}

// 取用户配置，拼出个性化系统提示（无配置则返回默认）
function buildUserSystemPromptFor(openId) {
  const cfg = getConfig(openId);
  if (!cfg) return undefined;
  return agent.buildUserSystemPrompt(cfg);
}

// 注入「当前用户身份锁定」：确保模型不会把群里其他成员的任务误算成本人的。
// 用配置里已存的飞书姓名（OAuth 登录时写入 displayName），无需额外 API 调用、低延迟。
// 这是身份锚定的第 2 道保险：即便模型没调用 feishu_chat_history 工具，也知道「我」是谁。
function injectIdentityPrompt(openId, baseSys) {
  const cfg = getConfig(openId);
  const name = (cfg && cfg.displayName) || '';
  const sys = baseSys || agent.systemPrompt;
  if (!name) return sys; // 配置里没有姓名（极少见），不强制锚定
  return (
    sys +
    `\n\n【当前用户身份锁定】你正以飞书用户「${name}」（open_id: ${openId}）的身份服务。` +
    `用户说的「我 / 我的 / 本人 / 我负责的」严格、唯一地指「${name}」，` +
    `绝对不要改写成群内其他成员（如王俏谊等）的名字，也绝不要自创「按你在群内的身份 XXX 整理」这类表述——` +
    `身份已由系统固定为 ${name}，请以它为准整理「我的」任务，且不得把其他成员（如王俏谊）的任务算到 ${name} 头上。`
  );
}

async function handleAgent(openId, text, history, sessionId, image, context) {
  // 会话持久化 + 多轮记忆（best-effort，失败不影响主流程）
  let sid = sessionId;
  let hist = history || [];

  // 构造用户消息内容：有图片则走多模态（文本 + image_url），否则纯文本
  let userContent;
  if (image) {
    const prompt =
      text && text.trim()
        ? text.trim()
        : '请分析这张图片：提取其中的文字，识别表格、时间、金额等关键信息，并简要概括主要内容。';
    userContent = [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: image } },
    ];
  } else {
    userContent = text;
  }

  try {
    if (!sid) {
      const sessions = await listSessions(openId);
      if (sessions && sessions.length) {
        sid = sessions[0].id; // 复用最近一次会话，形成连续上下文
        hist = (await getHistory(openId, sid, 12)) || [];
      } else {
        sid = await createSession(openId, (text || '图片消息').slice(0, 20));
      }
    }
    // 图片消息把多模态内容（含 data URL）一并落库，保证后续多轮仍带视觉上下文
    await appendMessage(sid, 'user', userContent);
  } catch (e) { console.error('[conv] 持久化失败:', e.message); }

  const result = await agent.run(userContent, {
    chat: (messages) => routeChat(openId, messages),
    history: hist,
    // 注入用户专属助手人设（botName + 自定义指令），实现「每个人配置自己的机器人」
    // 并锁定「当前用户身份」，防止群任务总结把别人的任务错算成本人。
    systemPrompt: injectIdentityPrompt(openId, buildUserSystemPromptFor(openId)),
    // 透传运行时上下文（openId / chatId），供飞书会话读取类工具使用
    context,
  });

  try { await appendMessage(sid, 'assistant', result.answer); } catch {}
  return { ...result, sessionId: sid };
}

// 统一消息处理入口：未配置用户回显 open_id，已配置则走 Agent 回复。
// Webhook 与长连接两种事件接收方式共用此函数。
// image: 飞书图片下载后的 data URL（可为 null）
// file:  飞书文件下载并提取后的结构化对象 { name, type, text, truncated }（可为 null）
async function processFeishuMessage(openId, text, image, file, chatId) {
  const ctx = { openId, chatId };
  try {
    if (!getConfig(openId)) {
      await sendText(
        openId,
        `👋 你还没有配置个人模型，暂时无法对话。\n\n` +
          `请用浏览器打开 https://acaily.areteailab.com/ ，点击「飞书登录」，` +
          `登录后在「个人设置」页填写你的模型（Provider / Base URL / Model / API Key），保存后即可在飞书里直接对话。`
      );
      return;
    }
    // 文件：把提取出的正文拼进 prompt，让模型基于文档作答
    if (file && file.text) {
      const prompt = buildFilePrompt(file, text);
      const r = await handleAgent(openId, prompt, null, null, null, ctx);
      await sendMarkdown(openId, r.answer);
      return;
    }

    // 飞书云文档链接：服务端直接拉正文注入模型，避免模型联网抓「需登录」页面
    const rawText = text ? text.trim() : '';
    if (rawText) {
      const links = extractFeishuDocLinks(rawText);
      if (links.length) {
        await handleFeishuDocLink(openId, links, rawText, ctx);
        return;
      }
    }

    const r = await handleAgent(openId, text ? text.trim() : '', null, null, image, ctx);
    await sendMarkdown(openId, r.answer);
  } catch (e) {
    console.error('[feishu] 处理消息失败:', e.message);
  }
}

// 处理用户发来的飞书云文档链接：能自动读取的（docx/doc）拉正文喂模型；
// 暂不支持的类型（wiki/sheets/base 等）给出友好提示。
async function handleFeishuDocLink(openId, links, userText, context) {
  // 优先取第一个「可自动读取」的链接；其余类型给提示
  const readable = links.find(isReadableCloudDoc);
  if (!readable) {
    const url = links[0].url;
    await sendText(
      openId,
      `📄 你发来的飞书链接（${url}）属于在线表格 / 知识库 / 多维表格等类型，我暂时无法直接读取。\n\n` +
        `请任选一种方式发给我：\n` +
        `1）把内容导出为 Word / PDF 后作为文件发送；\n` +
        `2）直接把正文粘贴到对话框。`
    );
    return;
  }
  try {
    const doc = await fetchFeishuDoc(readable.token);
    if (!doc.ok) {
      await sendText(
        openId,
        `⚠️ 无法读取该飞书文档：${doc.error}\n\n${doc.hint || ''}`
      );
      return;
    }
    const trunc = truncateExtracted(doc.text);
    const prompt = buildDocLinkPrompt(readable.url, trunc.text, userText, trunc.truncated);
    const r = await handleAgent(openId, prompt, null, null, null, context || {});
    await sendMarkdown(openId, r.answer);
  } catch (e) {
    console.error('[feishu] 读取云文档失败:', e.message);
    await sendText(openId, `⚠️ 读取云文档时出错：${e.message}`);
  }
}

// 把文件内容组织成模型可理解的指令：默认要求按「摘要/核心观点/数据结论/待办/风险」整理，
// 若用户附带了问题/要求则优先按用户要求作答。
function buildFilePrompt(file, text) {
  const head = `用户上传了文件《${file.name || '未命名文件'}》（类型 ${file.type || '未知'}${file.truncated ? '，内容较长已截断' : ''}）。`;
  const body = `文件正文如下：\n===== 文件内容开始 =====\n${file.text}\n===== 文件内容结束 =====`;
  const ask = text && text.trim()
    ? `\n\n用户针对该文件的问题/要求：${text.trim()}`
    : `\n\n请阅读并整理为：\n- 一句话摘要\n- 核心观点\n- 关键数据与结论\n- 待办事项、负责人和截止时间\n- 风险与需确认的问题`;
  return head + '\n' + body + ask;
}

// 把云文档正文组织成模型可理解的指令：默认按「摘要/核心要点/数据/待办/风险」整理；
// 若用户附带了问题/要求则优先按用户要求作答。已提供正文，明确告知无需联网搜索。
function buildDocLinkPrompt(url, docText, userText, truncated) {
  const head = `用户分享了一个飞书云文档（链接：${url}），我已读取到正文如下（文档内容已直接提供，请勿联网搜索该链接，直接基于以下内容作答）：${truncated ? '（文档较长已截断）' : ''}`;
  const body = `===== 文档内容开始 =====\n${docText}\n===== 文档内容结束 =====`;
  const ask = userText && userText.trim()
    ? `\n\n用户针对该文档的问题/要求：${userText.trim()}`
    : `\n\n请阅读并整理为：\n- 一句话摘要\n- 核心要点\n- 关键数据\n- 待办事项、负责人和截止时间\n- 风险与需确认的问题`;
  return head + '\n' + body + ask;
}

async function handleFeishuEvent(rawBody, headers) {
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (appSecret) {
    const ok = verifySignature({
      timestamp: headers['x-lark-request-timestamp'],
      nonce: headers['x-lark-request-nonce'],
      body: rawBody,
      signature: headers['x-lark-signature'],
    }, appSecret);
    if (!ok) return { status: 401, json: { code: 401, msg: '签名校验失败' } };
  }

  const parsed = parseEvent(rawBody);
  if (parsed.type === 'url_verification') {
    return { status: 200, json: { challenge: parsed.challenge } };
  }

  const msg = extractMessage(parsed);
  if (msg && msg.text) {
    // 快速返回 200，消息异步处理（Webhook 模式要求即时响应）
    processFeishuMessage(openId, msg.text.trim(), null, null, msg.chatId);
  }
  return { status: 200, json: { code: 0, msg: 'ok' } };
}

// ---------------- 鉴权辅助 ----------------
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const STATIC_TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml' };

// HTML 页面：未登录 → 跳登录页；返回会话或 null
function requireSessionHtml(req, res) {
  const s = parseSession(req);
  if (!s) { res.writeHead(302, { location: '/login' }); res.end(); return null; }
  return s;
}
// API：未登录 → 401；返回会话或 null
function requireSessionApi(req, res) {
  const s = parseSession(req);
  if (!s) { sendJson(res, 401, { error: '未登录，请先登录' }); return null; }
  return s;
}
// API：需管理员
function requireAdminApi(req, res) {
  const s = requireSessionApi(req, res);
  if (!s) return null;
  if (s.role !== 'admin') { sendJson(res, 403, { error: '需要管理员权限' }); return null; }
  return s;
}
async function serveHtml(res, file) {
  try {
    const html = await readFile(join(PUBLIC_DIR, file));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  } catch {
    return sendJson(res, 404, { error: 'not found' });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;
    const method = req.method || 'GET';

    // 公开：健康检查（监控/探活）
    if (method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true, ts: Date.now(), service: 'acaily', feishuWs: getFeishuWsStatus() });
    }

    // 登录页（公开）
    if (method === 'GET' && pathname === '/login') {
      return serveHtml(res, 'login.html');
    }
    // 发起飞书 OAuth：写 state Cookie 后 302 到授权页
    if (method === 'GET' && pathname === '/oauth/start') {
      const state = setOauthState(res);
      return res.writeHead(302, { location: getFeishuAuthorizeUrl(state) }), res.end();
    }
    // OAuth 回调：校验 state → 换票 → 取用户信息 → 建会话
    if (method === 'GET' && pathname === '/oauth/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const expected = getOauthState(req);
      if (!code || !state || !expected || state !== expected) {
        return sendJson(res, 400, { error: 'OAuth 校验失败（state 不匹配或缺少 code）' });
      }
      try {
        const tok = await exchangeCodeForToken(code);
        const info = await fetchFeishuUserInfo(tok.access_token);
        const openId = info.open_id || tok.open_id;
        const role = ensureAdmin(openId) ? 'admin' : 'user';
        setSessionCookie(res, {
          openId,
          name: info.name || '',
          avatar: info.avatar_url || '',
          email: info.email || '',
          role,
        }, req);
        return res.writeHead(302, { location: '/settings' }), res.end();
      } catch (e) {
        return sendJson(res, 502, { error: '登录失败：' + e.message });
      }
    }
    // 登出
    if (method === 'GET' && pathname === '/logout') {
      clearSessionCookie(res);
      return res.writeHead(302, { location: '/login' }), res.end();
    }

    // 静态资源（公开，供页面引用本地资源）
    if (method === 'GET' && pathname.startsWith('/static/')) {
      const rel = normalize(pathname.slice('/static/'.length));
      if (rel.includes('..')) return sendJson(res, 400, { error: '非法路径' });
      try {
        const buf = await readFile(join(PUBLIC_DIR, rel));
        return res.writeHead(200, { 'content-type': STATIC_TYPES[extname(rel)] || 'application/octet-stream' }), res.end(buf);
      } catch { return sendJson(res, 404, { error: 'not found' }); }
    }

    // 个人设置页（需登录）
    if (method === 'GET' && (pathname === '/' || pathname === '/settings')) {
      if (!requireSessionHtml(req, res)) return;
      return serveHtml(res, 'settings.html');
    }
    // 管理后台（需登录 + 管理员）
    if (method === 'GET' && pathname === '/admin') {
      const s = requireSessionHtml(req, res);
      if (!s) return;
      if (s.role !== 'admin') return sendJson(res, 403, { error: '需要管理员权限' });
      return serveHtml(res, 'admin.html');
    }

    // 公开：飞书事件回调（签名校验内置于 handleFeishuEvent）
    if (method === 'POST' && pathname === '/feishu/event') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const r = await handleFeishuEvent(rawBody, req.headers);
      return sendJson(res, r.status, r.json);
    }

    // ---- 以下均为需登录的 API ----

    // 当前登录用户身份
    if (method === 'GET' && pathname === '/api/me') {
      const s = requireSessionApi(req, res);
      if (!s) return;
      return sendJson(res, 200, { openId: s.openId, name: s.name, avatar: s.avatar, email: s.email, role: s.role });
    }

    // 个人配置（自服务，open_id 取自会话，绝不信任请求体）
    if (method === 'GET' && pathname === '/api/config/me') {
      const s = requireSessionApi(req, res);
      if (!s) return;
      const cfg = getConfig(s.openId);
      if (!cfg) return sendJson(res, 404, { error: '尚未配置', hasApiKey: false });
      const { _apiKeyEnc, ...safe } = cfg;
      return sendJson(res, 200, { config: safe, hasApiKey: !!_apiKeyEnc });
    }
    if (method === 'POST' && pathname === '/api/config/me') {
      const s = requireSessionApi(req, res);
      if (!s) return;
      try {
        const body = await readBody(req);
        const { openId, ...cfg } = body; // 丢弃客户端可能伪造的 openId
        const stored = setConfig(s.openId, { ...cfg, displayName: s.name || cfg.displayName || '' });
        const { _apiKeyEnc, ...safe } = stored;
        await record({ actor: s.openId, action: 'config.update', target: 'model-config', meta: { provider: cfg.provider, model: cfg.model, keyTouched: !!cfg.apiKey, botName: cfg.botName } });
        return sendJson(res, 200, { ok: true, config: safe, hasApiKey: !!_apiKeyEnc });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // 连通性测试（自服务）
    if (method === 'POST' && pathname === '/config/test') {
      const s = requireSessionApi(req, res);
      if (!s) return;
      const b = await readBody(req);
      const { provider, baseUrl, apiKey, model, chatCompletionsPath } = b;
      const inlineCfg = provider ? { provider, baseUrl, apiKey, model, chatCompletionsPath } : null;
      const r = await testConnection(s.openId, inlineCfg);
      return sendJson(res, 200, r);
    }

    // 网页对话（自服务，open_id 取会话）
    if (method === 'POST' && pathname === '/agent/chat') {
      const s = requireSessionApi(req, res);
      if (!s) return;
      const { text, history, sessionId } = await readBody(req);
      if (!text) return sendJson(res, 400, { error: 'text 必填' });
      try {
        const r = await handleAgent(s.openId, text, history, sessionId);
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 502, { error: e.message });
      }
    }
    if (method === 'POST' && pathname === '/chat') {
      const s = requireSessionApi(req, res);
      if (!s) return;
      const { messages } = await readBody(req);
      if (!Array.isArray(messages)) return sendJson(res, 400, { error: 'messages[] 必填' });
      try {
        const r = await handleChat(s.openId, messages);
        await record({ actor: s.openId, action: 'chat.call', target: 'model-gateway', meta: { provider: r.provider, model: r.model, attempt: r.attempt } });
        await record({ actor: s.openId, action: 'key.decrypt', target: 'kms', level: 'warn', meta: { provider: r.provider } });
        track({ openId: s.openId, provider: r.provider, tokens: (r.usage?.completionTokens || 0) + (r.usage?.promptTokens || 0) });
        return sendJson(res, 200, r);
      } catch (e) {
        await record({ actor: s.openId, action: 'chat.error', target: 'model-gateway', level: 'error', meta: { error: e.message } });
        return sendJson(res, 502, { error: e.message, degraded: e.degraded });
      }
    }

    // 会话历史（按 open_id 租户隔离，open_id 取会话）
    if (method === 'GET' && pathname.startsWith('/conversations/')) {
      const s = requireSessionApi(req, res);
      if (!s) return;
      const sessionId = decodeURIComponent(pathname.slice('/conversations/'.length));
      const hist = await getHistory(s.openId, sessionId);
      if (!hist) return sendJson(res, 404, { error: '会话不存在或无权限' });
      return sendJson(res, 200, { sessionId, history: hist });
    }
    if (method === 'GET' && pathname === '/conversations') {
      const s = requireSessionApi(req, res);
      if (!s) return;
      return sendJson(res, 200, { sessions: await listSessions(s.openId) });
    }

    // 知识库 RAG（T4，内部能力，需登录）
    if (method === 'POST' && pathname === '/kb/ingest') {
      const s = requireSessionApi(req, res);
      if (!s) return;
      const { docId, text, source } = await readBody(req);
      if (!docId || !text) return sendJson(res, 400, { error: 'docId 与 text 必填' });
      const ids = await retriever.ingest(docId, text, { source: source || docId });
      await record({ actor: s.openId, action: 'kb.ingest', target: 'knowledge', meta: { docId, chunks: ids.length } });
      return sendJson(res, 200, { ok: true, docId, chunks: ids.length });
    }
    if (method === 'POST' && pathname === '/kb/query') {
      const s = requireSessionApi(req, res);
      if (!s) return;
      const { query, topK } = await readBody(req);
      if (!query) return sendJson(res, 400, { error: 'query 必填' });
      const results = await retriever.retrieve(query, { topK: topK || 5 });
      await record({ actor: s.openId, action: 'kb.query', target: 'knowledge', meta: { query, hits: results.length } });
      return sendJson(res, 200, { query, results, context: retriever.buildContext(results) });
    }

    // ---- 管理后台 API（需管理员） ----
    if (method === 'GET' && pathname === '/api/admin/users') {
      const s = requireAdminApi(req, res);
      if (!s) return;
      return sendJson(res, 200, { users: listUsers(), adminOpenIds: listAdmins() });
    }
    if (method === 'GET' && pathname.startsWith('/api/admin/config/')) {
      const s = requireAdminApi(req, res);
      if (!s) return;
      const openId = decodeURIComponent(pathname.slice('/api/admin/config/'.length));
      const cfg = getConfig(openId);
      if (!cfg) return sendJson(res, 404, { error: '未找到该用户配置' });
      const { _apiKeyEnc, ...safe } = cfg;
      return sendJson(res, 200, { config: safe, hasApiKey: !!_apiKeyEnc });
    }
    if (method === 'PUT' && pathname.startsWith('/api/admin/config/')) {
      const s = requireAdminApi(req, res);
      if (!s) return;
      const openId = decodeURIComponent(pathname.slice('/api/admin/config/'.length));
      try {
        const body = await readBody(req);
        const { openId: _ign, ...cfg } = body;
        const stored = setConfig(openId, cfg);
        const { _apiKeyEnc, ...safe } = stored;
        await record({ actor: s.openId, action: 'admin.config.update', target: 'model-config', meta: { target: openId, provider: cfg.provider, model: cfg.model } });
        return sendJson(res, 200, { ok: true, config: safe, hasApiKey: !!_apiKeyEnc });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    if (method === 'DELETE' && pathname.startsWith('/api/admin/config/')) {
      const s = requireAdminApi(req, res);
      if (!s) return;
      const openId = decodeURIComponent(pathname.slice('/api/admin/config/'.length));
      const ok = deleteConfig(openId);
      await record({ actor: s.openId, action: 'admin.config.delete', target: 'model-config', meta: { target: openId } });
      return sendJson(res, 200, { ok });
    }
    if (method === 'POST' && pathname.startsWith('/api/admin/config/') && pathname.endsWith('/test')) {
      const s = requireAdminApi(req, res);
      if (!s) return;
      const openId = decodeURIComponent(pathname.slice('/api/admin/config/'.length, -'/test'.length));
      const b = await readBody(req);
      const { provider, baseUrl, apiKey, model, chatCompletionsPath } = b;
      const inlineCfg = provider ? { provider, baseUrl, apiKey, model, chatCompletionsPath } : null;
      const r = await testConnection(openId, inlineCfg);
      return sendJson(res, 200, r);
    }
    if (method === 'GET' && pathname === '/api/admin/audit') {
      const s = requireAdminApi(req, res);
      if (!s) return;
      const actor = url.searchParams.get('openId');
      return sendJson(res, 200, { events: await queryAudit({ actor, admin: true }) });
    }
    if (method === 'GET' && pathname === '/api/admin/stats') {
      const s = requireAdminApi(req, res);
      if (!s) return;
      return sendJson(res, 200, statsSnapshot());
    }

    // 兼容：旧的程序化后台接口（X-Admin-Token 静态令牌）
    if (pathname.startsWith('/admin/')) {
      if (!isAdmin(req)) return sendJson(res, 401, { error: '需要管理员令牌 (X-Admin-Token)' });
      if (method === 'GET' && pathname === '/admin/audit') {
        const actor = url.searchParams.get('openId');
        return sendJson(res, 200, { events: await queryAudit({ actor, admin: true }) });
      }
      if (method === 'GET' && pathname === '/admin/stats') {
        return sendJson(res, 200, statsSnapshot());
      }
      if (method === 'GET' && pathname === '/admin/compliance') {
        return sendJson(res, 200, selfAssess());
      }
      return sendJson(res, 404, { error: 'not found' });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => {
  console.log(`[acaily] 服务已启动 http://localhost:${PORT}`);
  // 飞书事件接收：长连接（WebSocket）主通道；Webhook 回调 /feishu/event 仍保留作兼容。
  startFeishuConnection(processFeishuMessage);
});

export { server };
