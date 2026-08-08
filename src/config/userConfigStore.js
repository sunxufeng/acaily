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

// 保存用户配置：校验通过后，把明文 apiKey 转成信封密文再落库
export function setConfig(openId, cfg) {
  const errors = validateUserModelConfig(cfg);
  if (errors.length) throw new Error('配置非法: ' + errors.join('; '));
  const db = load();
  const { apiKey, ...rest } = cfg;
  const stored = { ...rest, updatedAt: new Date().toISOString() };
  if (apiKey) stored._apiKeyEnc = encryptSecret(apiKey); // 信封加密
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

// 仅网关内部使用：解密出明文 API Key
export function decryptApiKey(openId) {
  const cfg = getConfig(openId);
  if (!cfg || !cfg._apiKeyEnc) return null;
  return decryptSecret(cfg._apiKeyEnc);
}
