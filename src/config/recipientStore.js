// 收件人地址簿（管理员手动添加的「组织架构成员」）。
// 与 configs.json 里「配置过模型的用户」不同，这里专门存放管理员从组织架构成员里
// 挑选出来的、可作为自动化推送目标的人。存 open_id + union_id（跨应用稳定），
// 这样即便对方从没给机器人发过消息，也能用 union_id 正确送达。
//
// 数据形状（recipients.json）：
//   { recipients: [ { id, openId, unionId, name, email, department, source, createdAt } ] }

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_PATH =
  process.env.ACAILY_RECIPIENT_STORE ||
  (process.env.ACAILY_CONFIG_STORE
    ? join(dirname(process.env.ACAILY_CONFIG_STORE), 'recipients.json')
    : join(__dirname, '../../data/recipients.json'));

const mem = { recipients: [] };

async function load() {
  if (!DEFAULT_PATH) return mem;
  try {
    const raw = await readFile(DEFAULT_PATH, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.recipients)) return { recipients: [] };
    return obj;
  } catch {
    return { recipients: [] };
  }
}

async function save(db) {
  if (!DEFAULT_PATH) return;
  await mkdir(dirname(DEFAULT_PATH), { recursive: true });
  await writeFile(DEFAULT_PATH, JSON.stringify(db, null, 2), 'utf8');
}

function dedupeKey(r) {
  return (r.unionId && `u:${r.unionId}`) || (r.openId && `o:${r.openId}`) || null;
}

export async function listRecipients() {
  const db = await load();
  return db.recipients.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
}

export async function findByOpenId(openId) {
  if (!openId) return null;
  const db = await load();
  return db.recipients.find((r) => r.openId === openId) || null;
}

export async function findByUnionId(unionId) {
  if (!unionId) return null;
  const db = await load();
  return db.recipients.find((r) => r.unionId === unionId) || null;
}

// 新增 / 更新一个收件人。相同 open_id 或 union_id 视为同一个人，做 upsert。
export async function addRecipient(input = {}) {
  const db = await load();
  const now = Date.now();
  const rec = {
    id: randomUUID(),
    openId: String(input.openId || '').trim(),
    unionId: String(input.unionId || '').trim(),
    name: String(input.name || '').trim(),
    email: String(input.email || '').trim(),
    department: String(input.department || '').trim(),
    source: String(input.source || 'manual'),
    createdAt: now,
  };
  const key = dedupeKey(rec);
  if (key) {
    const idx = db.recipients.findIndex((r) => {
      const k = dedupeKey(r);
      return k && k === key;
    });
    if (idx >= 0) {
      // 合并：保留已有字段，用新值补全空的
      const old = db.recipients[idx];
      db.recipients[idx] = {
        ...old,
        openId: rec.openId || old.openId,
        unionId: rec.unionId || old.unionId,
        name: rec.name || old.name,
        email: rec.email || old.email,
        department: rec.department || old.department,
        source: old.source === 'search' && rec.source === 'manual' ? old.source : rec.source,
        updatedAt: now,
      };
      await save(db);
      return db.recipients[idx];
    }
  }
  db.recipients.push(rec);
  await save(db);
  return rec;
}

export async function removeRecipient(id) {
  const db = await load();
  const before = db.recipients.length;
  db.recipients = db.recipients.filter((r) => r.id !== id);
  if (db.recipients.length === before) return false;
  await save(db);
  return true;
}
