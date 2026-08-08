// RBAC（T5.2）：管理员身份判定。
// 管理员来源（取并集）：
//   1) 环境变量 ACAILY_ADMIN_OPEN_IDS（逗号分隔，运维显式指定，优先级最高）
//   2) data/admins.json 持久化的列表（首次登录自适应：若系统尚无任何管理员，第一位登录者自动成为管理员）
// 普通接口用 isAdmin(req)（X-Admin-Token 静态令牌，供程序化调用）；
// 网页后台用 isAdminOpenId(openId)（会话角色判定）。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMINS_FILE =
  process.env.ACAILY_ADMINS_STORE || join(__dirname, '../../data/admins.json');

function loadEnvAdmins() {
  return (process.env.ACAILY_ADMIN_OPEN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadPersisted() {
  try {
    return JSON.parse(readFileSync(ADMINS_FILE, 'utf8')).admins || [];
  } catch {
    return [];
  }
}

function persist(list) {
  mkdirSync(dirname(ADMINS_FILE), { recursive: true });
  writeFileSync(ADMINS_FILE, JSON.stringify({ admins: list }, null, 2));
}

export function listAdmins() {
  return [...new Set([...loadEnvAdmins(), ...loadPersisted()])];
}

export function isAdminOpenId(openId) {
  return listAdmins().includes(openId);
}

// 登录时调用：判定并（必要时）引导成为管理员。
// 若环境变量已显式指定管理员，则不走自适应引导（避免越权）；否则系统尚无管理员时第一位登录者即管理员。
export function ensureAdmin(openId) {
  if (loadEnvAdmins().length) return isAdminOpenId(openId);
  const persisted = loadPersisted();
  if (persisted.length === 0) {
    persisted.push(openId);
    persist(persisted);
    return true;
  }
  return persisted.includes(openId);
}

// 程序化后台接口用的静态令牌校验（保留兼容）。
export function isAdmin(req) {
  const token =
    req.headers['x-admin-token'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  const expected = process.env.ACAILY_ADMIN_TOKEN;
  if (!expected) return false;
  return token === expected;
}
