import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateUserModelConfig } from './schema.js';
import { encryptSecret, decryptSecret } from '../crypto/kms.js';

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
export function setConfig(openId, cfg) {
  const prev = load().users[openId] || {};
  const apiKeyProvided = !!(cfg.apiKey && String(cfg.apiKey).trim());
  const keepExistingKey = !apiKeyProvided && prev._apiKeyEnc && !cfg.clearApiKey;
  // 仅在：非 ollama 且未提供新密钥 且 无既有密钥可沿用 时，才强制要求 apiKey
  const requireApiKey = !(cfg.provider === 'ollama' || apiKeyProvided || keepExistingKey);
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

export function listOpenIds() {
  return Object.keys(load().users);
}

// 管理后台用：列出全部用户配置摘要（不含 apiKey 明文/密文）
export function listUsers() {
  const db = load();
  return Object.entries(db.users)
    .map(([openId, c]) => ({
      openId,
      displayName: c.displayName || '',
      provider: c.provider || '',
      model: c.model || '',
      botName: c.botName || '',
      hasApiKey: !!c._apiKeyEnc,
      updatedAt: c.updatedAt || '',
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

// 仅网关内部使用：解密出明文 API Key
export function decryptApiKey(openId) {
  const cfg = getConfig(openId);
  if (!cfg || !cfg._apiKeyEnc) return null;
  return decryptSecret(cfg._apiKeyEnc);
}
