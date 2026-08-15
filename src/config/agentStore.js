// 智能体（Agent）配置存储：文件型 JSON 仓库（与 userConfigStore 同构）。
// 每个智能体包含人设三段（identity / user / soul）+ 可选绑定飞书应用。
// 绑定飞书应用的 app_secret 以信封密文（_enc）落库，不以明文暴露。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { encryptSecret, decryptSecret } from '../crypto/kms.js';
import { createJsonStore } from './jsonStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE = process.env.ACAILY_AGENT_STORE || join(__dirname, '../../data/agents.json');

// 进程内缓存 + 按 mtime/size 自动失效：外部手工改 agents.json 后无需重启即生效
const store = createJsonStore(STORE, { agents: {} });
function load() {
  const c = store.load();
  if (!c.agents) c.agents = {};
  return c;
}
function persist() {
  store.persist();
}

// 对外返回时剔除密文，仅暴露「是否已绑定 / 是否已配置模型 / owner」
function strip(a) {
  if (!a) return a;
  const { feishuAppSecretEnc, apiKeyEnc, ...rest } = a;
  return {
    ...rest,
    owner: a.owner || null,
    feishuAppBound: !!a.feishuAppId,
    hasApiKey: !!a.apiKeyEnc,
  };
}

// 列出智能体：
//   - 不传 owner（管理员全量视图）：返回全部
//   - 传 owner（登录用户视角）：返回「owner===该用户」+「owner 为空（组织共享）」两类，
//     实现「每个用户只能看/用自己的智能体，组织共享智能体所有人可用」，管理员仍能看全部。
export function listAgents(owner) {
  const db = load();
  let arr = Object.values(db.agents);
  if (owner) {
    arr = arr.filter((a) => a.owner === owner || !a.owner);
  }
  return arr
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
  // owner：创建时可指定（管理员可为某用户建专属智能体，或留空 = 组织共享）；未提供则沿用既有 owner。
  const owner = input.owner !== undefined ? (input.owner || null) : (existing.owner || null);
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
    // 可选：引用 Provider 池条目（管理员维护的可复用 provider/model 组合）
    providerPoolId: input.providerPoolId !== undefined ? (input.providerPoolId || null) : (existing.providerPoolId || null),
    // 归属用户（per-user 隔离）；为空 = 组织共享，所有登录用户可见可用
    owner,
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
