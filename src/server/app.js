import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { setConfig, getConfig, deleteConfig, listUsers, listOpenIds } from '../config/userConfigStore.js';
import { createSession, appendMessage, getHistory, listSessions } from '../config/conversationStore.js';
import { Retriever } from '../rag/retriever.js';
import { EmbeddingService } from '../rag/embeddings.js';
import { record, query as queryAudit } from '../audit/auditLog.js';
import { track, snapshot as statsSnapshot, aggregateUsage, ensureLoaded } from '../admin/stats.js';
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
import { routeChat, routeChatConfig, testConnection, rateLimitRemaining } from '../gateway/router.js';
import { AgentRuntime } from '../agent/runtime.js';
import { parseEvent, verifySignature, extractMessage } from '../feishu/event.js';
import { sendText, sendMarkdown } from '../feishu/client.js';
import { startFeishuConnection, startAgentConnections, startOneAgentConnection, getFeishuWsStatus } from '../feishu/connection.js';
import { extractFeishuDocLinks, isReadableCloudDoc, fetchFeishuDoc, fetchFeishuWiki } from '../feishu/docRead.js';
import { extractText, truncateExtracted } from '../feishu/fileExtract.js';
import { readRawBody, parseMultipart } from './multipart.js';
import { webTools } from '../tools/web.js';
import { feishuChatTools } from '../tools/feishuChat.js';
import {
  listAutomations,
  getAutomation,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  appendRun as appendAutomationRun,
} from '../automation/store.js';
import { scheduleAll, scheduleOne, unscheduleOne, triggerNow, activeJobCount } from '../automation/scheduler.js';
import { initRunner } from '../automation/runner.js';
import { listAgents, getAgent, saveAgent, deleteAgent, setFeishuBinding, listBoundAgents, getAgentApiKey } from '../config/agentStore.js';
import { createFeishuApp, enableBotCapability } from '../feishu/appMgmt.js';

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

// 自动化（T7.2）runner 依赖注入：让 runner 能复用 app.js 已建好的 agent 单例与函数，
// 避免重复构造或循环引用。
initRunner({ agent });

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

// 读取原始字节 + multipart 解析已抽到 ./multipart.js（这里仅保留 readBody）。

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

// 由智能体配置构造 systemPrompt（人设三段 + 名称/简介）
function buildAgentSystemPrompt(agent) {
  const parts = [`你正在以智能体「${agent.name}」${agent.emoji || ''} 的身份与用户对话。`];
  if (agent.description) parts.push(`简介：${agent.description}`);
  if (agent.identity) parts.push(`【身份 IDENTITY】\n${agent.identity}`);
  if (agent.user) parts.push(`【用户 USER】\n${agent.user}`);
  if (agent.soul) parts.push(`【灵魂 SOUL】\n${agent.soul}`);
  return parts.join('\n\n');
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
      if (context?.agentId) {
        // 智能体对话：按 用户+智能体 维度复用会话，避免与用户主对话历史串味
        const sessions = await listSessions(openId, context.agentId);
        if (sessions && sessions.length) {
          sid = sessions[0].id;
          hist = (await getHistory(openId, sid, 12)) || [];
        } else {
          sid = await createSession(openId, `智能体·${(text || '图片消息').slice(0, 12)}`, context.agentId);
        }
      } else {
        const sessions = await listSessions(openId);
        if (sessions && sessions.length) {
          sid = sessions[0].id; // 复用最近一次会话，形成连续上下文
          hist = (await getHistory(openId, sid, 12)) || [];
        } else {
          sid = await createSession(openId, (text || '图片消息').slice(0, 20));
        }
      }
    }
    // 图片消息把多模态内容（含 data URL）一并落库，保证后续多轮仍带视觉上下文
    await appendMessage(sid, 'user', userContent);
  } catch (e) { console.error('[conv] 持久化失败:', e.message); }

  // 智能体人设解析（chat 传 agentId 时，以其人设 + 模型为准）
  let agentPersona = null;
  let agentModel = null;
  let agentCfg = null;       // 智能体自有模型配置（provider/baseUrl/model）
  let agentApiKey = null;    // 智能体自有 API Key（明文，已解密）
  if (context?.agentId) {
    const ag = getAgent(context.agentId);
    if (ag) {
      agentPersona = buildAgentSystemPrompt(ag);
      agentModel = ag.model || null;
      if (ag.provider) {
        agentCfg = { id: ag.id, name: ag.name, provider: ag.provider, model: ag.model, baseUrl: ag.baseUrl, displayName: ag.name };
        agentApiKey = getAgentApiKey(ag.id);
      }
    }
  }

  const result = await agent.run(userContent, {
    // 智能体配置了自有模型 → 用其配置路由；否则回退到终端用户的个人配置（model 可被显式覆盖）
    chat: (messages) => {
      if (agentCfg) {
        return routeChatConfig(agentCfg, agentApiKey, messages, { model: context?.model || agentModel || null });
      }
      return routeChat(openId, messages, { model: context?.model || (agentModel || null) });
    },
    history: hist,
    // 注入用户专属助手人设（botName + 自定义指令），实现「每个人配置自己的机器人」
    // 并锁定「当前用户身份」，防止群任务总结把别人的任务错算成本人。
    // 优先级：调用方显式 systemPrompt > 指定智能体(agentId)的人设 > 默认用户人设。
    systemPrompt: context?.systemPrompt
      ? context.systemPrompt
      : (agentPersona || injectIdentityPrompt(openId, buildUserSystemPromptFor(openId))),
    // 透传运行时上下文（openId / chatId / agentId / feishuCreds），供飞书会话读取类工具使用
    context,
  });

  try { await appendMessage(sid, 'assistant', result.answer); } catch {}
  return { ...result, sessionId: sid };
}

// 统一消息处理入口：Webhook 与长连接两种事件接收方式共用此函数。
// image: 飞书图片下载后的 data URL（可为 null）
// file:  飞书文件下载并提取后的结构化对象（{ name, type, text, truncated } 或带 unsupported/cloudDoc 标记）
// agentId: 归属的智能体（主应用为 null）
// creds:  该消息所属飞书应用的 { appId, appSecret }（主应用为 null → 用环境变量身份回复）
async function processFeishuMessage(openId, text, image, file, chatId, agentId, creds) {
  const isAgent = !!agentId;
  const ctx = { openId, chatId, agentId: agentId || null, feishuCreds: creds || null };
  let agent = null;
  if (isAgent) {
    agent = getAgent(agentId);
    if (agent) {
      ctx.systemPrompt = buildAgentSystemPrompt(agent);
      ctx.model = agent.model || null;
    }
  }

  // —— 可回复性检查 ——
  const userCfg = getConfig(openId);
  if (isAgent && !agent) {
    await sendText(openId, '⚠️ 该智能体不存在或已被删除。', creds);
    return;
  }
  if (isAgent && !agent.provider && !userCfg) {
    await sendText(
      openId,
      `⚠️ 智能体「${agent.name || ''}」尚未配置模型，且你个人也未配置模型，暂时无法回复。\n\n` +
        `请在后台「智能体配置」为该智能体填写 Provider / Base URL / API Key / Model。`,
      creds
    );
    return;
  }
  if (!isAgent && !userCfg) {
    await sendText(
      openId,
      `👋 你还没有配置个人模型，暂时无法对话。\n\n` +
        `请用浏览器打开 https://acaily.areteailab.com/ ，点击「飞书登录」，` +
        `登录后在「个人设置」页填写你的模型（Provider / Base URL / Model / API Key），保存后即可在飞书里直接对话。`
    );
    return;
  }

  try {
    // 文件类（含不支持 / 云文档 / 读取失败等标记）
    if (file) {
      if (file.cloudDoc) {
        await sendText(
          openId,
          `📄《${file.name || '云文档'}》是飞书在线文档，我暂时无法直接读取在线文档内容。\n\n` +
            `请任选一种方式发给我：\n` +
            `1）把文档导出为 Word / PDF 后作为文件发送；\n` +
            `2）直接把正文粘贴到对话框。`,
          creds
        );
        return;
      }
      if (file.unsupported) {
        if (file.downloadSkipped) { await sendText(openId, '⚠️ 未配置飞书凭据，无法下载文件。', creds); return; }
        if (file.lowYield) {
          await sendText(
            openId,
            `⚠️ 这份 PDF 没能提取出足够的正文（可能是扫描件或特殊编码）。\n\n` +
              `请尝试：把 PDF 另存为 Word/文本后发送，或直接把正文粘贴给我，我可以照样帮你整理。`,
            creds
          );
          return;
        }
        if (file.error) { await sendText(openId, `⚠️ 文件读取失败：${file.error}`, creds); return; }
        await sendText(
          openId,
          `⚠️ 暂不支持读取该文件类型（${file.type || '未知'}）。\n\n` +
            `请发送以下可解析的格式：PDF / Word(.docx) / Excel(.xlsx) / PPT(.pptx) / TXT / Markdown，或直接粘贴正文。`,
          creds
        );
        return;
      }
      const prompt = buildFilePrompt(file, text);
      const r = await handleAgent(openId, prompt, null, null, null, ctx);
      await sendMarkdown(openId, r.answer, creds);
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

    const r = await handleAgent(openId, rawText, null, null, image, ctx);
    await sendMarkdown(openId, r.answer, creds);
  } catch (e) {
    console.error('[feishu] 处理消息失败:', e.message);
    try { await sendText(openId, `⚠️ 处理失败：${e.message}`, creds); } catch {}
  }
}

// 处理用户发来的飞书云文档链接：能自动读取的（docx / doc / wiki）拉正文喂模型；
// 暂不支持的类型（sheets / base / slides 等）给出友好提示。
async function handleFeishuDocLink(openId, links, userText, context) {
  // 优先取第一个「可自动读取」的链接；其余类型给提示
  const feishuCreds = context?.feishuCreds; // 智能体场景：用其绑定应用的身份回复
  const readable = links.find(isReadableCloudDoc);
  if (!readable) {
    const url = links[0].url;
    await sendText(
      openId,
      `📄 你发来的飞书链接（${url}）属于在线表格 / 多维表格 / 幻灯片等类型，我暂时无法直接读取。\n\n` +
        `请任选一种方式发给我：\n` +
        `1）把内容导出为 Word / PDF 后作为文件发送；\n` +
        `2）直接把正文粘贴到对话框。`,
      feishuCreds
    );
    return;
  }
  try {
    // docx / doc → 直接读 raw_content；wiki → 先 resolve node_token 为 obj_token
    const doc = readable.type === 'wiki'
      ? await fetchFeishuWiki(readable.token)
      : await fetchFeishuDoc(readable.token);
    if (!doc.ok) {
      await sendText(
        openId,
        `⚠️ 无法读取该飞书文档：${doc.error}\n\n${doc.hint || ''}`,
        feishuCreds
      );
      return;
    }
    const trunc = truncateExtracted(doc.text);
    const prompt = buildDocLinkPrompt(readable.url, trunc.text, userText, trunc.truncated);
    const r = await handleAgent(openId, prompt, null, null, null, context || {});
    await sendMarkdown(openId, r.answer, feishuCreds);
  } catch (e) {
    console.error('[feishu] 读取云文档失败:', e.message);
    await sendText(openId, `⚠️ 读取云文档时出错：${e.message}`, feishuCreds);
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
    // Webhook 路径属于主应用，agentId / creds 均为 null（使用主应用环境变量身份）
    processFeishuMessage(msg.openId, msg.text.trim(), null, null, msg.chatId, null, null);
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

    // CORS：允许浏览器扩展（chrome-extension://）与网页同源跨域带凭据调用 API
    const _origin = req.headers.origin;
    if (_origin && (_origin.startsWith('chrome-extension://') || _origin.endsWith('acplugin.areteailab.com'))) {
      res.setHeader('Access-Control-Allow-Origin', _origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (method === 'OPTIONS') return res.writeHead(204).end();

    // 公开：健康检查（监控/探活）
    if (method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true, ts: Date.now(), service: 'acaily', feishuWs: getFeishuWsStatus(), automationJobs: activeJobCount() });
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
      return serveHtml(res, 'app.html');
    }
    // 管理后台（需登录 + 管理员） —— 与 /settings 共用同一个 SPA shell，
    // 由 body 上的 is-admin class 控制 admin 入口可见性。
    if (method === 'GET' && pathname === '/admin') {
      const s = requireSessionHtml(req, res);
      if (!s) return;
      if (s.role !== 'admin') { res.writeHead(302, { 'location': '/settings' }); return res.end(); }
      return serveHtml(res, 'app.html');
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

    // 可用模型清单（供浏览器插件「切换模型」下拉填充）
    if (method === 'GET' && pathname === '/api/models') {
      const s = requireSessionApi(req, res);
      if (!s) return;
      const cfg = getConfig(s.openId);
      if (!cfg) return sendJson(res, 404, { error: '尚未配置模型' });
      const list = Array.isArray(cfg.models) && cfg.models.length ? cfg.models : (cfg.model ? [cfg.model] : []);
      return sendJson(res, 200, { provider: cfg.provider, model: cfg.model, models: list });
    }

    // 智能体清单（登录用户可见，供对话页「选择智能体」下拉）
    if (method === 'GET' && pathname === '/api/agents') {
      const s = requireSessionApi(req, res);
      if (!s) return;
      return sendJson(res, 200, { agents: listAgents() });
    }

    // ---- 智能体管理（管理员） ----
    if (pathname === '/api/admin/agents' || pathname.startsWith('/api/admin/agents/')) {
      const admin = requireAdminApi(req, res);
      if (!admin) return;
      // 详情 / 更新 / 删除 / 绑定：/api/admin/agents/:id(/bind-feishu)
      const m = pathname.match(/^\/api\/admin\/agents\/([^/]+)(\/bind-feishu)?$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const isBind = !!m[2];
        if (isBind) {
          if (method !== 'POST') return sendJson(res, 405, { error: '方法不允许' });
          const ag = getAgent(id);
          if (!ag) return sendJson(res, 404, { error: '智能体不存在' });
          try {
            const created = await createFeishuApp({ name: ag.name, description: ag.description });
            if (!created.ok) {
              return sendJson(res, 502, { error: '创建飞书应用失败：' + (created.msg || '未知错误'), code: created.code });
            }
            // 落库绑定（appId + appSecret，secret 以信封加密存储，供后续 WS 长连接与回复使用）
            const updated = saveAgent({ feishuAppId: created.appId, feishuAppSecret: created.appSecret }, id);
            let botNote = '';
            try {
              const bot = await enableBotCapability(created.appId);
              botNote = bot.ok ? '（机器人能力已启用）' : `（启用机器人能力提示：${bot.msg || ''}）`;
            } catch (e) { botNote = `（启用机器人能力失败：${e.message}）`; }
            await record({ actor: admin.openId, action: 'agent.bind_feishu', target: id, meta: { appId: created.appId } });
            // 绑定成功后热启动该智能体飞书应用的长连接（无需重启服务即可开始接收消息）
            try {
              startOneAgentConnection({ id, name: ag.name, appId: created.appId, appSecret: created.appSecret }, processFeishuMessage);
            } catch (e) { console.warn('[agent] 热启动长连接失败:', e.message); }
            return sendJson(res, 200, { ok: true, agent: updated, appId: created.appId, appSecret: created.appSecret, botNote });
          } catch (e) {
            return sendJson(res, 502, { error: '绑定飞书应用异常：' + e.message });
          }
        }
        if (method === 'GET') {
          const ag = getAgent(id);
          return ag ? sendJson(res, 200, { agent: ag }) : sendJson(res, 404, { error: '智能体不存在' });
        }
        if (method === 'PUT') {
          const body = await readBody(req);
          const ag = saveAgent(body, id);
          await record({ actor: admin.openId, action: 'agent.update', target: id, meta: { name: ag.name } });
          return sendJson(res, 200, { agent: ag });
        }
        if (method === 'DELETE') {
          const ok = deleteAgent(id);
          await record({ actor: admin.openId, action: 'agent.delete', target: id });
          return sendJson(res, ok ? 200 : 404, { ok });
        }
        return sendJson(res, 405, { error: '方法不允许' });
      }
      // 集合：GET 列表 / POST 新建
      if (method === 'GET') {
        return sendJson(res, 200, { agents: listAgents() });
      }
      if (method === 'POST') {
        const body = await readBody(req);
        if (!body || !String(body.name || '').trim()) return sendJson(res, 400, { error: 'name 必填' });
        const ag = saveAgent(body);
        await record({ actor: admin.openId, action: 'agent.create', target: ag.id, meta: { name: ag.name } });
        return sendJson(res, 200, { agent: ag });
      }
      return sendJson(res, 405, { error: '方法不允许' });
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

    // 网页附件上传：表单字段 file（任意类型，图片走 base64 dataUrl，文档走文本抽取）
    if (method === 'POST' && pathname === '/api/upload') {
      const s = requireSessionApi(req, res);
      if (!s) return;
      // ⚠️ 不能对 Content-Type 整串 toLowerCase()：boundary 值大小写会被改，但 body 内的 boundary
      //    仍是原大小写（Curl/Node fetch 等客户端可能用混合大小写），导致 indexOf 永远找不到分隔符。
      //    用 /i 正则只匹配前缀，捕获的 boundary 保留原大小写。
      const ct = req.headers['content-type'] || '';
      const m = ct.match(/^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;\r\n]+))/i);
      if (!m) return sendJson(res, 400, { error: '需要 multipart/form-data（缺少 boundary）' });
      const boundary = (m[1] || m[2]).trim();
      try {
        const buf = await readRawBody(req, 25 * 1024 * 1024);
        const parts = parseMultipart(buf, boundary);
        const filePart = parts.find((p) => p.name === 'file');
        if (!filePart) {
          const seen = parts.map((p) => p.name).filter(Boolean).join(',') || '(无字段)';
          return sendJson(res, 400, {
            error: '缺少 file 字段（解析到字段：' + seen + '；body=' + buf.length + 'B；boundary="' + boundary + '"）',
          });
        }
        const fileName = filePart.filename || 'upload';
        const mime = (filePart.contentType || '').toLowerCase();
        if (mime.startsWith('image/')) {
          if (filePart.data.length > 10 * 1024 * 1024) {
            return sendJson(res, 413, { error: '图片超过 10MB 上限' });
          }
          const dataUrl = 'data:' + (mime || 'image/png') + ';base64,' + filePart.data.toString('base64');
          return sendJson(res, 200, { kind: 'image', name: fileName, mime: mime, dataUrl });
        }
        // 文档类：走 fileExtract 抽文本
        const ext = (fileName.match(/\.[^.]+$/) || [''])[0].toLowerCase();
        const allowedDocExt = new Set(['.txt', '.md', '.csv', '.json', '.xml', '.html', '.htm', '.js', '.ts', '.py', '.java', '.go', '.rs', '.sh', '.sql', '.yml', '.yaml', '.log', '.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm', '.pdf']);
        if (!allowedDocExt.has(ext)) {
          return sendJson(res, 400, { error: '不支持的文件类型：' + (ext || '(无扩展名)') });
        }
        const result = extractText(filePart.data, fileName, mime);
        if (result.unsupported) {
          return sendJson(res, 400, { error: result.reason || '此文件类型暂不支持抽取文本' });
        }
        const tr = truncateExtracted(result.text);
        const fileObj = { name: fileName, type: mime || ext, text: tr.text, truncated: !!tr.truncated };
        return sendJson(res, 200, { kind: 'file', file: fileObj });
      } catch (e) {
        return sendJson(res, 400, { error: '上传解析失败：' + e.message });
      }
    }

    // 网页对话（自服务，open_id 取会话）
    if (method === 'POST' && pathname === '/agent/chat') {
      const s = requireSessionApi(req, res);
      if (!s) return;
      const body = await readBody(req);
      let { text, history, sessionId, image, file, model, systemPrompt, agentId } = body || {};
      if (!text && !image && !file) return sendJson(res, 400, { error: 'text / image / file 至少给一项' });
      try {
        // 文档附件：把抽取出的正文拼到提示词里，再交给 agent
        let promptText = text || '';
        let chatImage = image || null;
        if (file && file.text) {
          promptText = buildFilePrompt(file, promptText);
        }
        const r = await handleAgent(s.openId, promptText, history, sessionId, chatImage, {
          model: model || null,
          systemPrompt: systemPrompt || null,
          agentId: agentId || null,
        });
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
    // 全员统一配置下发（移植自 acplugin 的 POST /api/admin/org/push）：把一份基础配置应用到全部用户。
    // 不强制要求 apiKey：未提供 apiKey 时，各用户既有密钥会被保留（setConfig 的 keepExistingKey 逻辑）。
    if (method === 'POST' && pathname === '/api/admin/push') {
      const s = requireAdminApi(req, res);
      if (!s) return;
      try {
        const body = await readBody(req);
        const { openId: _ign, ...pushCfg } = body;
        const ids = listOpenIds();
        let affected = 0;
        const skipped = [];
        for (const id of ids) {
          try {
            setConfig(id, pushCfg, { forceApiKey: false });
            affected++;
          } catch {
            skipped.push(id);
          }
        }
        await record({
          actor: s.openId,
          action: 'admin.config.push',
          target: 'model-config',
          meta: { affected, skipped: skipped.length, provider: pushCfg.provider },
        });
        return sendJson(res, 200, { ok: true, affected, skipped: skipped.length });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
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
    // ---- 使用统计（T9.0）：按时间窗口聚合 token/调用 ----
    if (method === 'GET' && pathname === '/api/admin/usage') {
      const s = requireAdminApi(req, res);
      if (!s) return;
      const rangeParam = (url.searchParams.get('range') || '30d').toLowerCase();
      const m = /^(\d+)d$/.exec(rangeParam);
      const rangeDays = m ? Math.min(365, Math.max(1, Number(m[1]))) : 30;
      const users = listUsers() || [];
      const userMap = {};
      for (const u of users) { if (u.openId) userMap[u.openId] = u.displayName || ''; }
      // 注入 admin 自己（万一没在配置表里）
      userMap[s.openId] = (await getConfig(s.openId))?.displayName || userMap[s.openId] || '';
      await ensureLoaded();
      return sendJson(res, 200, aggregateUsage({ rangeDays, userMap }));
    }

    // ---- 自动化（T7.2）后台 API ----
    if (method === 'GET' && pathname === '/api/admin/automations') {
      const s = requireAdminApi(req, res);
      if (!s) return;
      const list = await listAutomations();
      return sendJson(res, 200, { automations: list, activeJobs: activeJobCount() });
    }
    if (method === 'POST' && pathname === '/api/admin/automations') {
      const s = requireAdminApi(req, res);
      if (!s) return;
      try {
        const body = await readBody(req);
        const auto = await createAutomation(body);
        if (auto.enabled !== false) scheduleOne(auto);
        await record({ actor: s.openId, action: 'automation.create', target: auto.id, meta: { title: auto.title, cron: auto.cron, pushTo: auto.pushTo.length } });
        return sendJson(res, 200, { ok: true, automation: auto });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    // 路径参数路由：/api/admin/automations/:id[/action]
    if (method === 'PATCH' && pathname.startsWith('/api/admin/automations/')) {
      const s = requireAdminApi(req, res);
      if (!s) return;
      const id = decodeURIComponent(pathname.slice('/api/admin/automations/'.length));
      try {
        const body = await readBody(req);
        const auto = await updateAutomation(id, body);
        // 变更后重新调度：cron / enabled 改了都要重排；其它字段改了也重排最稳
        if (auto.enabled !== false) scheduleOne(auto); else unscheduleOne(id);
        await record({ actor: s.openId, action: 'automation.update', target: id, meta: { enabled: auto.enabled, cron: auto.cron } });
        return sendJson(res, 200, { ok: true, automation: auto });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    if (method === 'DELETE' && pathname.startsWith('/api/admin/automations/')) {
      const s = requireAdminApi(req, res);
      if (!s) return;
      const id = decodeURIComponent(pathname.slice('/api/admin/automations/'.length));
      const ok = await deleteAutomation(id);
      if (ok) unscheduleOne(id);
      await record({ actor: s.openId, action: 'automation.delete', target: id });
      return sendJson(res, 200, { ok });
    }
    if (method === 'POST' && /^\/api\/admin\/automations\/[^/]+\/run$/.test(pathname)) {
      const s = requireAdminApi(req, res);
      if (!s) return;
      const id = decodeURIComponent(pathname.slice('/api/admin/automations/'.length, -'/run'.length));
      try {
        await triggerNow(id);
        await record({ actor: s.openId, action: 'automation.manual_run', target: id });
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
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
// 启动时加载 usage.jsonl，避免「重启即失去历史数据」
ensureLoaded()
  .then(() => console.log('[usage] 历史事件加载完毕'))
  .catch((e) => console.error('[usage] 历史加载失败:', e.message));
server.listen(PORT, () => {
  console.log(`[acaily] 服务已启动 http://localhost:${PORT}`);
  // 飞书事件接收：长连接（WebSocket）主通道；Webhook 回调 /feishu/event 仍保留作兼容。
  startFeishuConnection(processFeishuMessage);
  // 为每个「已绑定飞书应用」的智能体启动独立的长连接，实现多机器人消息路由。
  startAgentConnections(processFeishuMessage);
  // 自动化（T7.2）启动调度：加载持久化的全部自动化并挂上 cron。
  scheduleAll()
    .then((r) => console.log(`[automation] 已加载 ${r.total} 条，调度 ${r.scheduled} 条`))
    .catch((e) => console.error('[automation] 启动调度失败:', e.message));
});

export { server };
