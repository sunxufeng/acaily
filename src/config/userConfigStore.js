import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateUserModelConfig } from './schema.js';
import { encryptSecret, decryptSecret } from '../crypto/kms.js';
import { listDirectory } from './userDirectoryStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE = process.env.ACAILY_CONFIG_STORE || join(__dirname, '../../data/configs.json');

let cache = null;

function load() {
  if (cache) return cache;
  if (existsSync(STORE)) {
    cache = JSON.parse(readFileSync(STORE, 'utf8'));
  } else {
    cache = { users: {} };
  }
  return cache;
}

function persist() {
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify(cache, null, 2));
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

// 管理后台用：列出全部用户配置摘要（不含 apiKey 明文/密文）
// 合并「用户目录」：把仅登录过、尚未配置模型的用户也列入（displayName 取自目录，hasApiKey=false）。
// 显示名解析优先级：通讯录目录 > 个人配置里的 displayName。
// 通讯录来自飞书 OAuth，名字最权威；configs.json 里的 displayName 仅为兼容历史记录。
export function listUsers() {
  const db = load();
  // 通讯录 → openId → displayName 索引
  const dirMap = {};
  for (const d of listDirectory()) {
    if (d && d.openId && d.displayName) dirMap[d.openId] = d.displayName;
  }
  const cfgUsers = Object.entries(db.users).map(([openId, c]) => ({
    openId,
    displayName: dirMap[openId] || c.displayName || '',
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

let orgCache = null;

function loadOrg() {
  if (orgCache) return orgCache;
  if (existsSync(ORG_DEFAULT_FILE)) {
    try {
      orgCache = JSON.parse(readFileSync(ORG_DEFAULT_FILE, 'utf8'));
    } catch {
      orgCache = {};
    }
  } else {
    orgCache = {};
  }
  return orgCache;
}

function persistOrg() {
  mkdirSync(dirname(ORG_DEFAULT_FILE), { recursive: true });
  writeFileSync(ORG_DEFAULT_FILE, JSON.stringify(orgCache, null, 2));
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
