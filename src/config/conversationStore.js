// 对话历史存储：按 open_id 做逻辑租户隔离（T3.1）
// 数据落 JSON 文件；生产环境可替换为 pgvector / 专用存储并加物理隔离。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_PATH = process.env.ACAILY_CONV_STORE || '/tmp/acaily-conversations.json';

function emptyDb() { return { sessions: {}, messages: {} }; }

async function load(path = DEFAULT_PATH) {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return emptyDb();
  }
}

async function save(db, path = DEFAULT_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(db, null, 2), 'utf8');
}

/** 创建新会话；返回 sessionId */
export async function createSession(openId, title = '新对话') {
  const db = await load();
  const sessionId = randomUUID();
  db.sessions[sessionId] = {
    openId,
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.messages[sessionId] = [];
  await save(db);
  return sessionId;
}

/** 追加一条消息（role: user|assistant|system） */
export async function appendMessage(sessionId, role, content, meta = {}) {
  const db = await load();
  if (!db.messages[sessionId]) db.messages[sessionId] = [];
  const msg = { id: randomUUID(), role, content, meta, at: new Date().toISOString() };
  db.messages[sessionId].push(msg);
  if (db.sessions[sessionId]) db.sessions[sessionId].updatedAt = msg.at;
  await save(db);
  return msg;
}

/** 获取某会话历史（按 open_id 鉴权，越权返回 null） */
export async function getHistory(openId, sessionId, limit = 50) {
  const db = await load();
  const sess = db.sessions[sessionId];
  if (!sess || sess.openId !== openId) return null; // 租户隔离：跨用户不可见
  const all = db.messages[sessionId] || [];
  return all.slice(-limit).map(({ role, content }) => ({ role, content }));
}

/** 列出某用户的所有会话 */
export async function listSessions(openId) {
  const db = await load();
  return Object.entries(db.sessions)
    .filter(([, s]) => s.openId === openId)
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
