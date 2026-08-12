// 通讯录查询：用「具备 contact 权限」的智能体应用（优先观澜）的 tenant token
// 读取组织架构，支撑「管理员把任意组织成员指定为自动化收件人」。
//
// 权限前提（飞书开放平台）：
//   - 应用需开启 contact:contact.base:readonly（读单个用户，GET /contact/v3/users/{id} 可用）
//   - 搜索 / 列出需 contact:user.base:readonly + contact:department.base:readonly，
//     且应用的「通讯录权限范围」需设为「全部员工」，否则只能看到权限范围内的人。
// 任意一步缺少权限都会静默降级（resolve 返回 null、search 返回空），不影响其它功能。

import { getTenantToken } from './client.js';
import { listAgents, getAgentFeishuSecret } from '../config/agentStore.js';

const FEISHU_HOST = 'https://open.feishu.cn';

let _contactApp = null; // { appId, appSecret }
let _searchAvailable = null; // 搜索接口是否可用（用于给前端提示）

// 选一个「绑定了飞书应用 + 具备通讯录权限」的智能体应用作为通讯录读取身份。
// 优先观澜（已知有权限），否则取第一个绑定了飞书应用的智能体。
async function getContactApp() {
  if (_contactApp) return _contactApp;
  const agents = listAgents() || [];
  const pick =
    agents.find((a) => a.name === '观澜') ||
    agents.find((a) => a.feishuAppId) ||
    null;
  if (!pick || !pick.feishuAppId) return null;
  const secret = getAgentFeishuSecret(pick.id);
  if (!secret) return null;
  _contactApp = { appId: pick.feishuAppId, appSecret: secret };
  return _contactApp;
}

// 把飞书 user 对象归一化为 { openId, unionId, name, email, department }
function normalize(u) {
  if (!u) return null;
  return {
    openId: u.open_id || '',
    unionId: u.union_id || '',
    name: u.name || '',
    email: u.email || u.email_id || '',
    department: Array.isArray(u.departments) ? u.departments.join('/') : (u.department || ''),
  };
}

/**
 * 按 open_id 或 union_id 解析单个用户（GET /contact/v3/users/{id}）。
 * @returns {Promise<{openId,unionId,name,email,department}|null>}
 */
export async function resolveContact(id, idType = 'union_id') {
  const app = await getContactApp();
  if (!app || !id) return null;
  const token = await getTenantToken(app);
  if (!token) return null;
  try {
    const res = await fetch(
      `${FEISHU_HOST}/open-apis/contact/v3/users/${encodeURIComponent(id)}?user_id_type=${idType}`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    if (data.code === 0 && data.data && data.data.user) return normalize(data.data.user);
  } catch {
    /* 权限不足 / 用户不在可见范围 → 静默返回 null */
  }
  return null;
}

/**
 * 按姓名 / 拼音 / 邮箱片段搜索组织成员。
 * @returns {Promise<{items:Array, available:boolean, note?:string}>}
 *   available=false 表示应用缺少搜索权限或可见范围受限，前端应提示管理员去开放平台授权。
 */
export async function searchContacts(q, { pageSize = 20 } = {}) {
  const app = await getContactApp();
  if (!app) return { items: [], available: false, note: '未找到具备通讯录权限的智能体应用（需观澜/启明等绑定了飞书应用且开启 contact 权限）' };
  const token = await getTenantToken(app);
  if (!token) return { items: [], available: false, note: '无法获取通讯录应用令牌' };
  if (!q || !q.trim()) return { items: [], available: true };
  try {
    const res = await fetch(
      `${FEISHU_HOST}/open-apis/contact/v3/users/search?user_id_type=union_id`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: q.trim(), page_size: Math.min(50, pageSize) }),
      }
    );
    const data = await res.json();
    if (data.code === 0) {
      _searchAvailable = true;
      const items = (data.data && data.data.items || []).map(normalize).filter(Boolean);
      return { items, available: true };
    }
    // 99991663=令牌缺少搜索所需 scope；40004=缺部门权限；其它也一律降级
    _searchAvailable = false;
    return {
      items: [],
      available: false,
      note: `通讯录搜索不可用（飞书返回 ${data.code} ${data.msg}）。请到飞书开放平台为「${app.appId}」应用开启 contact:user.base:readonly + contact:department.base:readonly，并把「通讯录权限范围」设为「全部员工」。`,
    };
  } catch {
    _searchAvailable = false;
    return { items: [], available: false, note: '通讯录搜索请求失败（网络/代理异常）' };
  }
}

export function isSearchAvailable() {
  return _searchAvailable;
}

/**
 * 列出组织架构内的全部成员（用于「下拉批量多选 / 全选全体人员」）。
 * 通过 GET /contact/v3/users 分页拉取；受应用可见范围限制，只能看到授权范围内的员工。
 * @returns {Promise<{items:Array, available:boolean, note?:string, total?:number, truncated?:boolean}>}
 */
export async function listAllContacts({ pageSize = 50, maxPages = 40 } = {}) {
  const app = await getContactApp();
  if (!app) return { items: [], available: false, note: '未找到具备通讯录权限的智能体应用（需观澜/启明等绑定了飞书应用且开启 contact 权限）' };
  const token = await getTenantToken(app);
  if (!token) return { items: [], available: false, note: '无法获取通讯录应用令牌' };
  try {
    const items = [];
    let pageToken = '';
    let pages = 0;
    do {
      const u = new URL(`${FEISHU_HOST}/open-apis/contact/v3/users`);
      u.searchParams.set('user_id_type', 'union_id');
      u.searchParams.set('page_size', String(Math.min(50, pageSize)));
      if (pageToken) u.searchParams.set('page_token', pageToken);
      const res = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.code !== 0) {
        return {
          items,
          available: false,
          note: `通讯录列表不可用（飞书返回 ${data.code} ${data.msg}）。请到飞书开放平台为「${app.appId}」开启 contact:user.base:readonly，并把「通讯录权限范围」设为「全部员工」。`,
          total: items.length,
          truncated: true,
        };
      }
      const chunk = (data.data && data.data.items || []).map(normalize).filter(Boolean);
      items.push(...chunk);
      pageToken = (data.data && data.data.page_token) || '';
      pages++;
    } while (pageToken && pages < maxPages);
    return { items, available: true, total: items.length, truncated: pages >= maxPages };
  } catch {
    return { items: [], available: false, note: '通讯录列表请求失败（网络/代理异常）' };
  }
}
