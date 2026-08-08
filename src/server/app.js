import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { setConfig, getConfig, deleteConfig } from '../config/userConfigStore.js';
import { createSession, appendMessage, getHistory, listSessions } from '../config/conversationStore.js';
import { Retriever } from '../rag/retriever.js';
import { EmbeddingService } from '../rag/embeddings.js';
import { record, query as queryAudit } from '../audit/auditLog.js';
import { track, snapshot as statsSnapshot } from '../admin/stats.js';
import { isAdmin } from '../auth/rbac.js';
import { selfAssess } from '../compliance/checklist.js';
import { routeChat, testConnection, rateLimitRemaining } from '../gateway/router.js';
import { AgentRuntime } from '../agent/runtime.js';
import { parseEvent, verifySignature, extractMessage } from '../feishu/event.js';
import { sendText } from '../feishu/client.js';

// 内置示例工具：演示 Agent 工具调用（后续可替换为真实 MCP 工具）
const tools = [
  {
    name: 'get_time',
    description: '获取当前服务器时间，参数为空对象 {}',
    run: async () => new Date().toISOString(),
  },
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

async function handleAgent(openId, text, history, sessionId) {
  // 会话持久化（best-effort，失败不影响主流程）
  let sid = sessionId;
  try {
    if (!sid) sid = await createSession(openId, text.slice(0, 20));
    await appendMessage(sid, 'user', text);
  } catch (e) { console.error('[conv] 持久化失败:', e.message); }

  const result = await agent.run(text, {
    chat: (messages) => routeChat(openId, messages),
    history: history || [],
  });

  try { await appendMessage(sid, 'assistant', result.answer); } catch {}
  return { ...result, sessionId: sid };
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
    // 异步处理（飞书要求快速返回 200）
    handleAgent(msg.openId, msg.text.trim())
      .then((r) => sendText(msg.openId, r.answer))
      .catch((e) => console.error('[feishu] 处理消息失败:', e.message));
  }
  return { status: 200, json: { code: 0, msg: 'ok' } };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;
    const method = req.method || 'GET';

    // 静态资源：个人设置页 H5
    const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
    const STATIC_TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml' };
    if (method === 'GET' && (pathname === '/' || pathname === '/settings')) {
      const html = await readFile(join(PUBLIC_DIR, 'settings.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (method === 'GET' && pathname.startsWith('/static/')) {
      const rel = normalize(pathname.slice('/static/'.length));
      if (rel.includes('..')) return sendJson(res, 400, { error: '非法路径' });
      try {
        const buf = await readFile(join(PUBLIC_DIR, rel));
        return res.writeHead(200, { 'content-type': STATIC_TYPES[extname(rel)] || 'application/octet-stream' }), res.end(buf);
      } catch { return sendJson(res, 404, { error: 'not found' }); }
    }

    if (method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true, ts: Date.now(), service: 'acaily' });
    }

    if (method === 'POST' && pathname === '/chat') {
      const { openId, messages } = await readBody(req);
      if (!openId || !Array.isArray(messages)) {
        return sendJson(res, 400, { error: 'openId 与 messages[] 必填' });
      }
      try {
        const r = await handleChat(openId, messages);
        // 审计：对话调用 + 密钥解密使用（敏感），统计用量
        await record({ actor: openId, action: 'chat.call', target: 'model-gateway', meta: { provider: r.provider, model: r.model, attempt: r.attempt } });
        await record({ actor: openId, action: 'key.decrypt', target: 'kms', level: 'warn', meta: { provider: r.provider } });
        track({ openId, provider: r.provider, tokens: (r.usage?.completionTokens || 0) + (r.usage?.promptTokens || 0) });
        return sendJson(res, 200, r);
      } catch (e) {
        await record({ actor: openId, action: 'chat.error', target: 'model-gateway', level: 'error', meta: { error: e.message } });
        return sendJson(res, 502, { error: e.message, degraded: e.degraded });
      }
    }

    if (method === 'POST' && pathname === '/agent/chat') {
      const { openId, text, history, sessionId } = await readBody(req);
      if (!openId || !text) return sendJson(res, 400, { error: 'openId 与 text 必填' });
      try {
        const r = await handleAgent(openId, text, history, sessionId);
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 502, { error: e.message });
      }
    }

    // 会话历史（T3.1）：按 open_id 租户隔离
    if (method === 'GET' && pathname.startsWith('/conversations/')) {
      const sessionId = decodeURIComponent(pathname.slice('/conversations/'.length));
      const openId = url.searchParams.get('openId');
      if (!openId) return sendJson(res, 400, { error: 'openId 必填' });
      const hist = await getHistory(openId, sessionId);
      if (!hist) return sendJson(res, 404, { error: '会话不存在或无权限' });
      return sendJson(res, 200, { sessionId, history: hist });
    }
    if (method === 'GET' && pathname === '/conversations') {
      const openId = url.searchParams.get('openId');
      if (!openId) return sendJson(res, 400, { error: 'openId 必填' });
      return sendJson(res, 200, { sessions: await listSessions(openId) });
    }

    // 知识库 RAG（T4）
    if (method === 'POST' && pathname === '/kb/ingest') {
      const { docId, text, source } = await readBody(req);
      if (!docId || !text) return sendJson(res, 400, { error: 'docId 与 text 必填' });
      const ids = await retriever.ingest(docId, text, { source: source || docId });
      await record({ actor: 'system', action: 'kb.ingest', target: 'knowledge', meta: { docId, chunks: ids.length } });
      return sendJson(res, 200, { ok: true, docId, chunks: ids.length });
    }
    if (method === 'POST' && pathname === '/kb/query') {
      const { query, topK } = await readBody(req);
      if (!query) return sendJson(res, 400, { error: 'query 必填' });
      const results = await retriever.retrieve(query, { topK: topK || 5 });
      await record({ actor: 'system', action: 'kb.query', target: 'knowledge', meta: { query, hits: results.length } });
      return sendJson(res, 200, { query, results, context: retriever.buildContext(results) });
    }

    if (method === 'POST' && pathname === '/config') {
      const { openId, ...cfg } = await readBody(req);
      if (!openId) return sendJson(res, 400, { error: 'openId 必填' });
      try {
        const stored = setConfig(openId, cfg);
        const { _apiKeyEnc, ...safe } = stored;
        await record({ actor: openId, action: 'config.update', target: 'model-config', meta: { provider: cfg.provider, model: cfg.model, keyTouched: !!cfg.apiKey } });
        return sendJson(res, 200, { ok: true, config: safe, hasApiKey: !!_apiKeyEnc });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (method === 'GET' && (pathname.startsWith('/config/') || pathname === '/config')) {
      const fromPath = pathname.startsWith('/config/') ? decodeURIComponent(pathname.slice('/config/'.length)) : null;
      const openId = fromPath || url.searchParams.get('openId');
      if (!openId) return sendJson(res, 400, { error: 'openId 必填（路径 /config/{openId} 或查询参数 ?openId=）' });
      const cfg = getConfig(openId);
      if (!cfg) return sendJson(res, 404, { error: '未找到该用户配置' });
      const { _apiKeyEnc, ...safe } = cfg;
      return sendJson(res, 200, { config: safe, hasApiKey: !!_apiKeyEnc });
    }

    if (method === 'DELETE' && pathname.startsWith('/config/')) {
      const openId = decodeURIComponent(pathname.slice('/config/'.length));
      const ok = deleteConfig(openId);
      return sendJson(res, 200, { ok });
    }

    if (method === 'POST' && pathname === '/config/test') {
      const { openId } = await readBody(req);
      if (!openId) return sendJson(res, 400, { error: 'openId 必填' });
      const r = await testConnection(openId);
      return sendJson(res, 200, r);
    }

    if (method === 'GET' && pathname.startsWith('/ratelimit/')) {
      const openId = decodeURIComponent(pathname.slice('/ratelimit/'.length));
      return sendJson(res, 200, { openId, remaining: rateLimitRemaining(openId) });
    }

    if (method === 'POST' && pathname === '/feishu/event') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const r = await handleFeishuEvent(rawBody, req.headers);
      return sendJson(res, r.status, r.json);
    }

    // 企业管理后台（T5.1/T5.2）：审计日志、用量统计、合规自检（管理员令牌保护）
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
});

export { server };
