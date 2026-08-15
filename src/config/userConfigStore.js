import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateUserModelConfig } from './schema.js';
import { encryptSecret, decryptSecret } from '../crypto/kms.js';
import { listDirectory } from './userDirectoryStore.js';
import { createJsonStore } from './jsonStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE = process.env.ACAILY_CONFIG_STORE || join(__dirname, '../../data/configs.json');

// 进程内缓存 + 按 mtime/size 自动失效：外部手工改 configs.json 后无需重启即生效
const cfgStore = createJsonStore(STORE, { users: {} });
function load() {
  const c = cfgStore.load();
  if (!c.users) c.users = {};
  return c;
}
function persist() {
  cfgStore.persist();
}

// 读取用户配置（已加密的 apiKey 以 _apiKeyEnc 信封形式存储，不以明文暴露）
export function getConfig(openId) {
  const db = load();
  return db.users[openId] || null;
}

// 保存用户配置：校验通过后，把明文 apiKey 转成信封密文再落库。
// 兼容管理后台：clearApiKey=true 时清空已存密钥；apiKey 留空且已有密钥则保留既有密钥。
// forceApiKey=false 时（如管理端「全员下发」）不强制要求 apiKey，缺失密钥由用户后续自填。
export function setConfig(openId, cfg, { forceApiKey = true } = {}) {
  const prev = load().users[openId] || {};
  const apiKeyProvided = !!(cfg.apiKey && String(cfg.apiKey).trim());
  const keepExistingKey = !apiKeyProvided && prev._apiKeyEnc && !cfg.clearApiKey;
  // 仅在：非 ollama 且未提供新密钥 且 无既有密钥可沿用 且 调用方要求强校验 时，才强制要求 apiKey
  const requireApiKey = forceApiKey && !(cfg.provider === 'ollama' || apiKeyProvided || keepExistingKey);
  const errors = validateUserModelConfig(cfg, { requireApiKey });
  if (errors.length) throw new Error('配置非法: ' + errors.join('; '));
  const db = load();
  const { apiKey, clearApiKey, ...rest } = cfg;
  const stored = { ...prev, ...rest, updatedAt: new Date().toISOString() };
  if (apiKeyProvided) {
    stored._apiKeyEnc = encryptSecret(String(cfg.apiKey).trim()); // 信封加密
  } else if (clearApiKey) {
    delete stored._apiKeyEnc;
  }
  // 未提供 apiKey 且未要求清除 → 保留 prev._apiKeyEnc（rest 里已带入）
  db.users[openId] = stored;
  persist();
  return stored;
}

export function deleteConfig(openId) {
  const db = load();
  if (db.users[openId]) {
    delete db.users[openId];
    persist();
    return true;
  }
  return false;
}

// 跨应用推送所需：记录某 open_id 对应的 union_id（同一开发商旗下各应用间稳定一致）。
// union_id 来自用户发来的 inbound 事件（sender.sender_id.union_id），无需额外飞书权限即可获取。
export function getUnionId(openId) {
  const cfg = getConfig(openId);
  return (cfg && cfg.unionId) || null;
}

export function setUnionId(openId, unionId) {
  if (!openId || !unionId) return;
  const db = load();
  const prev = db.users[openId];
  // 只为「已存在的用户」（配置过模型 / 管理员 / 地址簿里的人）回写 union_id；
  // 不为「随便给机器人发消息的陌生用户」新建空壳条目，避免 /api/admin/users 里冒出幽灵收件人。
  // 陌生人若日后被管理员添加为收件人，其 union_id 会随 pushRecipients 显式落库，无需在此预存。
  if (!prev) return;
  if (prev.unionId === unionId) return; // 无变化不落盘
  db.users[openId] = { ...prev, unionId, updatedAt: new Date().toISOString() };
  persist();
}

export function listOpenIds() {
  return Object.keys(load().users);
}

// 取「更完整」的显示名：两者都非空时取较长的（避免飞书 OAuth 的简短名覆盖管理员/用户手动维护的全名，
// 例如「Arete Developer」被目录里的「Arete」截断）。长度相同则偏向配置里的（管理员可维护）。
function bestDisplayName(dir, cfg) {
  const a = (dir || '').trim();
  const b = (cfg || '').trim();
  if (!a) return b;
  if (!b) return a;
  return b.length >= a.length ? b : a;
}

// 管理后台用：列出全部用户配置摘要（不含 apiKey 明文/密文）
// 合并「用户目录」：把仅登录过、尚未配置模型的用户也列入（displayName 取自目录，hasApiKey=false）。
// 显示名解析：目录名与个人配置名取「更完整」的一个（见 bestDisplayName），不再让目录无条件覆盖配置。
export function listUsers() {
  const db = load();
  // 通讯录 → openId → displayName 索引
  const dirMap = {};
  for (const d of listDirectory()) {
    if (d && d.openId && d.displayName) dirMap[d.openId] = d.displayName;
  }
  const cfgUsers = Object.entries(db.users).map(([openId, c]) => ({
    openId,
    displayName: bestDisplayName(dirMap[openId], c.displayName),
    provider: c.provider || '',
    model: c.model || '',
    botName: c.botName || '',
    hasApiKey: !!c._apiKeyEnc,
    updatedAt: c.updatedAt || '',
  }));
  const cfgSet = new Set(Object.keys(db.users));
  // 目录里、但不在配置库中的用户 → 作为「登录过但未配置」列出
  const dirUsers = listDirectory()
    .filter((d) => d.openId && !cfgSet.has(d.openId))
    .map((d) => ({
      openId: d.openId,
      displayName: d.displayName || '',
      provider: '',
      model: '',
      botName: '',
      hasApiKey: false,
      updatedAt: d.lastSeen || '',
    }));
  return [...cfgUsers, ...dirUsers].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

// 仅网关内部使用：解密出明文 API Key
export function decryptApiKey(openId) {
  const cfg = getConfig(openId);
  if (!cfg || !cfg._apiKeyEnc) return null;
  return decryptSecret(cfg._apiKeyEnc);
}

// ============== 组织默认配置（全员下发模板） ==============
// 管理员在「组织默认配置」页执行一键下发时，除把配置写进各用户条目外，
// 还会把这份「不含 API Key 的基础配置」持久化为组织默认模板。
// 新登录、尚未自行配置的个人用户在 GET /api/config/me 时会继承该模板，
// 因此「普通用户登录后也能看到组织下发的配置」，只需补全自己的 API Key。
const ORG_DEFAULT_FILE =
  process.env.ACAILY_ORG_DEFAULT_STORE || join(__dirname, '../../data/orgDefault.json');

// 组织默认配置模板：同样带 mtime/size 自动失效
const orgStore = createJsonStore(ORG_DEFAULT_FILE, {});
function loadOrg() {
  return orgStore.load();
}
function persistOrg() {
  orgStore.persist();
}

export function getOrgDefault() {
  const db = loadOrg();
  return db.default || null;
}

// 保存组织默认模板：剥离 apiKey 明文/密文（密钥是 per-user 的，不能沉淀为组织模板），
// 仅保留 provider / baseUrl / model / 采样参数等基础项。
export function setOrgDefault(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  const { apiKey, _apiKeyEnc, clearApiKey, openId, ...rest } = cfg;
  const tpl = { ...rest, updatedAt: new Date().toISOString() };
  const db = loadOrg();
  db.default = tpl;
  persistOrg();
  return tpl;
}
