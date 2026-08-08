// 审计日志（T5.2）：全链路记录配置变更/对话/密钥访问，按 actor 租户隔离，管理员可看全部。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_PATH = process.env.ACAILY_AUDIT_STORE;
const mem = []; // 未配置持久化时的内存兜底

async function load() {
  if (!DEFAULT_PATH) return mem;
  try { return JSON.parse(await readFile(DEFAULT_PATH, 'utf8')); } catch { return []; }
}
async function save(db) {
  if (!DEFAULT_PATH) return;
  await mkdir(dirname(DEFAULT_PATH), { recursive: true });
  await writeFile(DEFAULT_PATH, JSON.stringify(db, null, 2), 'utf8');
}

export async function record({ actor, action, target, meta = {}, level = 'info' }) {
  const entry = { id: randomUUID(), ts: new Date().toISOString(), actor, action, target, level, meta };
  const db = await load();
  db.push(entry);
  await save(db);
  return entry;
}

export async function query({ actor, action, limit = 100, admin = false } = {}) {
  const db = await load();
  return db
    .filter((e) => (admin ? true : !actor || e.actor === actor))
    .filter((e) => !action || e.action === action)
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .slice(0, limit);
}
