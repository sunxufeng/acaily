// 菜单权限配置存储（T10·权限配置）
// 管理员可为普通用户授权「额外菜单」（自动化任务 / 智能体配置）。
// 基础菜单（对话 / Provider / 关于）普通用户默认拥有、不可取消；管理员永远拥有全部。
// 注：「Provider」页已合并「我的配置 + 组织共享 Provider 池」，对所有用户常驻，不再单独授权。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE = process.env.ACAILY_PERMISSIONS_STORE || join(__dirname, '../../data/permissions.json');

// 普通用户可被管理员授权启用的「额外菜单」（基础菜单默认拥有，不在此列）
export const GRANTABLE_MENUS = [
  { key: 'automation', label: '自动化任务' },
  { key: 'agents', label: '智能体配置' },
];
// 普通用户默认拥有、不可取消的基础菜单（在权限配置页以固定行展示）
export const BASE_MENUS = ['chat', 'provider', 'about'];
// 基础菜单的展示信息（权限配置页渲染固定行用）
export const BASE_DISPLAY_MENUS = [
  { key: 'chat', label: '对话' },
  { key: 'provider', label: 'Provider' },
  { key: 'about', label: '关于' },
];

let cache = null;
function load() {
  if (cache) return cache;
  if (existsSync(STORE)) {
    try {
      cache = JSON.parse(readFileSync(STORE, 'utf8'));
    } catch {
      cache = { permissions: {} };
    }
  } else {
    cache = { permissions: {} };
  }
  if (!cache.permissions) cache.permissions = {};
  return cache;
}
function persist() {
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify(cache, null, 2));
}

export function getPermissions(openId) {
  const db = load();
  return db.permissions[openId] || null;
}

// 保存某用户的授权菜单（仅接受 GRANTABLE_MENUS 中的 key，去重）
export function setPermissions(openId, menus) {
  const valid = new Set(GRANTABLE_MENUS.map((m) => m.key));
  const clean = Array.from(new Set((menus || []).filter((m) => valid.has(m))));
  const db = load();
  db.permissions[openId] = clean;
  persist();
  return clean;
}

// 解析某用户最终可见的菜单集合：
//   管理员 → 返回 ['all']（前端视为全部）；
//   普通用户 → BASE_MENUS + 授权菜单。
export function resolveMenus(openId, role) {
  if (role === 'admin') return ['all'];
  const granted = getPermissions(openId) || [];
  return Array.from(new Set([...BASE_MENUS, ...granted]));
}

// 批量列出用户的授权菜单（供权限配置页渲染）。
// openIds / displayNames 由调用方从用户清单传入。
export function listPermissions(openIds, displayNames) {
  const db = load();
  return openIds.map((openId) => ({
    openId,
    displayName: (displayNames && displayNames[openId]) || '',
    menus: db.permissions[openId] || [],
  }));
}
