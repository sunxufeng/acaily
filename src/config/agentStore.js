// 智能体（Agent）配置存储：文件型 JSON 仓库（与 userConfigStore 同构）。
// 每个智能体包含人设三段（identity / user / soul）+ 可选绑定飞书应用。
// 绑定飞书应用的 app_secret 以信封密文（_enc）落库，不以明文暴露。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { encryptSecret, decryptSecret } from '../crypto/kms.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE = process.env.ACAILY_AGENT_STORE || join(__dirname, '../../data/agents.json');

let cache = null;

function load() {
  if (cache) return cache;
  if (existsSync(STORE)) {
    try {
      cache = JSON.parse(readFileSync(STORE, 'utf8'));
    } catch {
      cache = { agents: {} };
    }
  } else {
    cache = { agents: {} };
  }
  if (!cache.agents) cache.agents = {};
  return cache;
}

function persist() {
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify(cache, null, 2));
}

// 对外返回时剔除密文，仅暴露「是否已绑定 / 是否已配置模型」
function strip(a) {
  if (!a) return a;
  const { feishuAppSecretEnc, apiKeyEnc, ...rest } = a;
  return {
    ...rest,
    feishuAppBound: !!a.feishuAppId,
    hasApiKey: !!a.apiKeyEnc,
  };
}

export function listAgents() {
  const db = load();
  return Object.values(db.agents)
    .map(strip)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function getAgent(id) {
  return strip(load().agents[id] || null);
}

// 内部用：含密文，仅限服务端绑定流程
export function getAgentRaw(id) {
  return load().agents[id] || null;
}

const clamp = (s, n) => (s == null ? '' : String(s).slice(0, n));

export function saveAgent(input, id) {
  const db = load();
  const now = new Date().toISOString();
  const existing = (id && db.agents[id]) || {};
  const a = {
    id: existing.id || id || randomUUID(),
    name: clamp(input.name, 60) || '未命名智能体',
    emoji: clamp(input.emoji, 8) || '🤖',
    description: clamp(input.description, 500),
    identity: clamp(input.identity, 4000),
    user: clamp(input.user, 4000),
    soul: clamp(input.soul, 4000),
    model: input.model ? clamp(input.model, 80) : (existing.model || null),
    // 智能体自有模型配置（回复时使用，不依赖终端用户个人配置）
    provider: input.provider ? clamp(input.provider, 40) : (existing.provider || null),
    baseUrl: input.baseUrl ? clamp(input.baseUrl, 400) : (existing.baseUrl || null),
    // 飞书绑定信息保留（除非显式改）
    feishuAppId: input.feishuAppId !== undefined ? input.feishuAppId : existing.feishuAppId,
    feishuAppBound: existing.feishuAppBound || false,
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
  // app_secret 仅在新建/更新时落库；clearFeishuSecret 用于清空
  if (input.feishuAppSecret) {
    a.feishuAppSecretEnc = encryptSecret(String(input.feishuAppSecret));
  } else if (input.clearFeishuSecret) {
    delete a.feishuAppSecretEnc;
  } else if (existing.feishuAppSecretEnc) {
    a.feishuAppSecretEnc = existing.feishuAppSecretEnc;
  }
  // apiKey 同样以信封加密落库；clearApiKey 用于清空
  if (input.apiKey) {
    a.apiKeyEnc = encryptSecret(String(input.apiKey));
  } else if (input.clearApiKey) {
    delete a.apiKeyEnc;
  } else if (existing.apiKeyEnc) {
    a.apiKeyEnc = existing.apiKeyEnc;
  }
  db.agents[a.id] = a;
  persist();
  return strip(a);
}

// 仅更新飞书绑定结果（由绑定流程调用）
export function setFeishuBinding(id, { appId, bound }) {
  const db = load();
  const a = db.agents[id];
  if (!a) return null;
  a.feishuAppId = appId || a.feishuAppId;
  a.feishuAppBound = !!bound;
  a.updatedAt = new Date().toISOString();
  db.agents[id] = a;
  persist();
  return strip(a);
}

export function deleteAgent(id) {
  const db = load();
  if (db.agents[id]) {
    delete db.agents[id];
    persist();
    return true;
  }
  return false;
}

export function getAgentFeishuSecret(id) {
  const a = getAgentRaw(id);
  if (!a || !a.feishuAppSecretEnc) return null;
  try {
    return decryptSecret(a.feishuAppSecretEnc);
  } catch {
    return null;
  }
}

// 解密智能体自有模型 API Key（供网关以智能体身份调用模型）
export function getAgentApiKey(id) {
  const a = getAgentRaw(id);
  if (!a || !a.apiKeyEnc) return null;
  try {
    return decryptSecret(a.apiKeyEnc);
  } catch {
    return null;
  }
}

// 列出已绑定飞书应用、且持有 app_secret 的智能体（供启动各应用的 WS 长连接）。
// 返回 { id, name, appId, appSecret }（appSecret 为明文，仅服务端内存使用）。
export function listBoundAgents() {
  const db = load();
  const out = [];
  for (const a of Object.values(db.agents)) {
    if (a.feishuAppId && a.feishuAppSecretEnc) {
      const secret = getAgentFeishuSecret(a.id);
      if (secret) out.push({ id: a.id, name: a.name, appId: a.feishuAppId, appSecret: secret });
    }
  }
  return out;
}
