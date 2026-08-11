// Provider 池：管理员维护的可复用 Provider/Model 组合，智能体与个人配置都可从此选择。
// 落库 data/providers.json（与 agentStore/userConfigStore 同构）。
// 每条记录：
//   id, name（展示名）, type（openai/anthropic/ollama/custom/acplugin）
//   baseUrl, apiKeyEnc（信封密文）, models[]（模型列表，首项为默认）
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { encryptSecret, decryptSecret } from '../crypto/kms.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE = process.env.ACAILY_PROVIDER_POOL_STORE || join(__dirname, '../../data/providers.json');

let cache = null;

function load() {
  if (cache) return cache;
  if (existsSync(STORE)) {
    try {
      cache = JSON.parse(readFileSync(STORE, 'utf8'));
    } catch {
      cache = { providers: {} };
    }
  } else {
    cache = { providers: {} };
  }
  if (!cache.providers) cache.providers = {};
  return cache;
}

function persist() {
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify(cache, null, 2));
}

// 对外暴露：剔除 apiKeyEnc，仅暴露 hasKey
function strip(p) {
  if (!p) return p;
  const { apiKeyEnc, ...rest } = p;
  return { ...rest, hasKey: !!apiKeyEnc };
}

export function listProviders() {
  return Object.values(load().providers).map(strip).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function getProvider(id) {
  return strip(load().providers[id] || null);
}

export function getProviderRaw(id) {
  return load().providers[id] || null;
}

const clamp = (s, n) => (s == null ? '' : String(s).slice(0, n));

export function saveProvider(input, id) {
  const db = load();
  const now = new Date().toISOString();
  const existing = (id && db.providers[id]) || {};
  const p = {
    id: existing.id || id || randomUUID(),
    name: clamp(input.name, 60) || '未命名 Provider',
    type: clamp(input.type, 40) || (existing.type || 'openai'),
    baseUrl: input.baseUrl != null ? clamp(input.baseUrl, 400) : (existing.baseUrl || ''),
    models: Array.isArray(input.models) ? input.models.map((m) => clamp(m, 80)).filter(Boolean) : (existing.models || []),
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
  if (input.apiKey) {
    p.apiKeyEnc = encryptSecret(String(input.apiKey));
  } else if (input.clearApiKey) {
    delete p.apiKeyEnc;
  } else if (existing.apiKeyEnc) {
    p.apiKeyEnc = existing.apiKeyEnc;
  }
  db.providers[p.id] = p;
  persist();
  return strip(p);
}

export function deleteProvider(id) {
  const db = load();
  if (db.providers[id]) {
    delete db.providers[id];
    persist();
    return true;
  }
  return false;
}

export function getProviderApiKey(id) {
  const p = getProviderRaw(id);
  if (!p || !p.apiKeyEnc) return null;
  try {
    return decryptSecret(p.apiKeyEnc);
  } catch {
    return null;
  }
}