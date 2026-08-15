// 用户目录：记录每一个登录过系统的用户（含「仅登录、尚未配置模型」的普通用户）。
// 与 userConfigStore（模型配置）解耦——目录只管「谁登录过、叫什么」，
// 因此即便用户未配置任何模型，管理员也能在用户列表里看到他。
// 同时不影响 userConfigStore 的「组织默认配置继承」逻辑（该逻辑依赖 getConfig 返回 null）。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJsonStore } from './jsonStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE = process.env.ACAILY_USER_DIR_STORE || join(__dirname, '../../data/userDirectory.json');

// 进程内缓存 + 按 mtime/size 自动失效：外部手工改 userDirectory.json 后无需重启即生效
const store = createJsonStore(STORE, { users: {} });
// 进程内去重：每个 openId 在一个进程生命周期内最多落盘一次（避免每次鉴权都写文件）
const _seen = new Set();

function load() {
  const c = store.load();
  if (!c.users) c.users = {};
  return c;
}

function persist() {
  store.persist();
}

// 完整记录（OAuth 回调时调用）：首次登录建档，之后更新姓名/头像/邮箱与 lastSeen
export function recordLogin(openId, info = {}) {
  if (!openId) return;
  const db = load();
  const now = new Date().toISOString();
  const prev = db.users[openId] || {};
  db.users[openId] = {
    openId,
    displayName: info.name || prev.displayName || '',
    avatar: info.avatar || prev.avatar || '',
    email: info.email || prev.email || '',
    firstSeen: prev.firstSeen || now,
    lastSeen: now,
  };
  persist();
  _seen.add(openId);
}

// 轻量触碰（每次鉴权时调用）：仅当本进程尚未记录过该用户时才落盘一次，
// 用于把「在修复上线前就已经登录、却未留痕」的活跃用户回填进目录。
export function touchLogin(openId, info = {}) {
  if (!openId || _seen.has(openId)) return;
  recordLogin(openId, info);
}

// 目录全量（供管理后台用户列表与显示名解析合并使用）
export function listDirectory() {
  const db = load();
  return Object.values(db.users);
}
