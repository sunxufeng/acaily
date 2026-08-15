// Provider 池：管理员维护的「组织共享 Provider」与个人 Provider 共享同一文件。
// 落库 data/providers.json（与 agentStore/userConfigStore 同构）。
// 每条记录：
//   id, owner（'admin' | openId），parentId?（分发时记录来源，仅 distributed copy 有）
//   name（展示名）, type（openai/anthropic/ollama/custom/acplugin）
//   baseUrl, apiKeyEnc（信封密文）, models[]（模型列表，首项为默认）
//   disabled（停用标记，列表渲染为「已停用」），distributedAt（最近一次被分发的时间）
//
// - owner='admin'：组织共享 Provider。管理员在「组织共享 Provider」页 CRUD。
//                  通过「分发」克隆一条到目标用户个人空间（owner=openId, parentId=源 id）。
// - owner=openId：个人 Provider。「我的 Provider」页 CRUD + 停用。
//                  可能 parentId 指向某个组织共享 Provider（admin 再次分发会刷新其配置）。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { encryptSecret, decryptSecret } from '../crypto/kms.js';
import { createJsonStore } from './jsonStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE = process.env.ACAILY_PROVIDER_POOL_STORE || join(__dirname, '../../data/providers.json');

// 进程内缓存 + 按 mtime/size 自动失效：外部手工改 providers.json 后无需重启即生效
const store = createJsonStore(STORE, { providers: {} });
function load() {
  const c = store.load();
  if (!c.providers) c.providers = {};
  return c;
}
function persist() {
  store.persist();
}
// 管理端「放弃外部改动 / 强制重载」时用
export function invalidateProviderPool() {
  store.invalidate();
}

// 对外暴露：剔除 apiKeyEnc，仅暴露 hasKey
function strip(p) {
  if (!p) return p;
  const { apiKeyEnc, ...rest } = p;
  return { ...rest, hasKey: !!apiKeyEnc };
}

const clamp = (s, n) => (s == null ? '' : String(s).slice(0, n));

// 仅暴露掩码预览（前 4 + … + 后 4），绝不返回明文。用于前端「显示」已存密钥的概况。
function maskKey(k) {
  if (!k) return '';
  k = String(k);
  if (k.length <= 8) return k.length ? '•'.repeat(Math.min(k.length, 6)) : '';
  return k.slice(0, 4) + '…' + k.slice(-4);
}

// 把一条记录归一化为「owner + base fields」齐全的形状，缺字段补默认。
// 旧数据（无 owner 字段）视为组织共享（owner='admin'），保留兼容性。
function normalize(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    id: p.id,
    owner: p.owner || 'admin',
    parentId: p.parentId || null,
    disabled: !!p.disabled,
    name: p.name || '未命名 Provider',
    type: p.type || 'openai',
    baseUrl: p.baseUrl || '',
    models: Array.isArray(p.models) ? p.models : [],
    emoji: p.emoji || '🧩',
    apiKeyEnc: p.apiKeyEnc || null,
    keyMask: p.keyMask || '',
    distributedAt: p.distributedAt || null,
    extra: (p.extra && typeof p.extra === 'object') ? p.extra : {},
    createdAt: p.createdAt || new Date().toISOString(),
    updatedAt: p.updatedAt || new Date().toISOString(),
  };
}

// 全量列表（管理员视角，按 updatedAt 倒序）
export function listProviders() {
  return Object.values(load().providers).map(normalize).filter(Boolean).map(strip).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

// 仅组织共享（owner='admin'）
export function listOrgProviders() {
  return Object.values(load().providers)
    .map(normalize)
    .filter((p) => p && p.owner === 'admin')
    .map(strip)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

// 个人 Provider 列表：owner=openId 的全部记录 + 该用户已收到的组织共享分发副本。
// 这里只返回 owner=openId 的记录；组织共享本身（在另一页可见），不在这里列出，避免重复。
export function listUserProviders(openId) {
  if (!openId) return [];
  return Object.values(load().providers)
    .map(normalize)
    .filter((p) => p && p.owner === openId)
    .map(strip)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function getProvider(id) {
  const p = normalize(load().providers[id]);
  return p ? strip(p) : null;
}

export function getProviderRaw(id) {
  return normalize(load().providers[id]);
}

// 保存：opts.owner 用于新建时指定归属（admin/openId）；编辑时保留既有 owner。
// opts.alwaysSetOwner=true 用于「分发」流程强制覆盖 owner。
export function saveProvider(input, id, opts = {}) {
  const db = load();
  const now = new Date().toISOString();
  const existing = (id && normalize(db.providers[id])) || null;
  const p = {
    id: existing ? existing.id : (id || randomUUID()),
    owner: opts.alwaysSetOwner ? (opts.owner || existing.owner || 'admin') : (existing ? existing.owner : (opts.owner || 'admin')),
    parentId: existing ? existing.parentId : null,
    disabled: typeof input.disabled === 'boolean' ? input.disabled : (existing ? existing.disabled : false),
    name: clamp(input.name, 60) || (existing && existing.name) || '未命名 Provider',
    type: clamp(input.type, 40) || (existing && existing.type) || 'openai',
    baseUrl: input.baseUrl != null ? clamp(input.baseUrl, 400) : ((existing && existing.baseUrl) || ''),
    models: Array.isArray(input.models) ? input.models.map((m) => clamp(m, 80)).filter(Boolean) : ((existing && existing.models) || []),
    emoji: clamp(input.emoji || (existing && existing.emoji) || '🧩', 8),
    distributedAt: existing ? existing.distributedAt : null,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
  if (input.apiKey) {
    p.apiKeyEnc = encryptSecret(String(input.apiKey));
    p.keyMask = maskKey(input.apiKey);
  } else if (input.clearApiKey) {
    delete p.apiKeyEnc;
    delete p.keyMask;
  } else if (existing && existing.apiKeyEnc) {
    p.apiKeyEnc = existing.apiKeyEnc;
    p.keyMask = existing.keyMask;
  }
  // 附加配置（采样参数 / 超时重试 / 多模态 / 流式 / 自定义请求头 / Chat 接口路径等）。
  // 前端提交完整 extra 对象整体覆盖；未提交则保留旧值（兼容旧数据）。
  const inExtra = (input.extra && typeof input.extra === 'object') ? input.extra : null;
  p.extra = inExtra ? inExtra : ((existing && existing.extra) || {});
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

// 切换停用标记（启用/停用）。
export function setProviderDisabled(id, disabled) {
  const db = load();
  const p = normalize(db.providers[id]);
  if (!p) return null;
  p.disabled = !!disabled;
  p.updatedAt = new Date().toISOString();
  db.providers[id] = p;
  persist();
  return strip(p);
}

// 把组织共享 Provider 分发到一组用户：为每位用户创建或刷新一份副本。
// 已存在的副本（owner=openId 且 parentId=sourceId）：覆盖 name/type/baseUrl/apiKey/models/emoji/disabled。
// apiKey 强制沿用源条目（清空时清空、保留时保留），不强制要求源条目有 Key。
// 返回 { distributed: [openId], skipped: [{openId, reason}] }
export function distributeProvider(sourceId, openIds) {
  const db = load();
  const src = normalize(db.providers[sourceId]);
  if (!src) throw new Error('源 Provider 不存在');
  if (src.owner !== 'admin') throw new Error('只能分发组织共享 Provider');
  const targets = Array.from(new Set((openIds || []).filter(Boolean)));
  const distributed = [];
  const skipped = [];
  for (const openId of targets) {
    try {
      // 查找该用户是否已有此源的副本（按 parentId）
      let existingId = null;
      for (const [pid, raw] of Object.entries(db.providers)) {
        const r = normalize(raw);
        if (r && r.owner === openId && r.parentId === sourceId) {
          existingId = pid;
          break;
        }
      }
      // 强制用源条目的 Key 覆盖（清空=清空、否则沿用源）
      const apiKey = src.apiKeyEnc ? decryptSecret(src.apiKeyEnc) : null;
      const payload = {
        name: src.name,
        type: src.type,
        baseUrl: src.baseUrl,
        models: src.models,
        emoji: src.emoji,
        disabled: src.disabled,
        apiKey: apiKey || undefined,
        extra: src.extra && typeof src.extra === 'object' ? src.extra : {},
      };
      const newRec = saveProvider(payload, existingId, { owner: openId, alwaysSetOwner: true });
      // 标记 parentId + distributedAt
      const stored = db.providers[newRec.id];
      stored.parentId = sourceId;
      stored.distributedAt = new Date().toISOString();
      stored.updatedAt = new Date().toISOString();
      persist();
      distributed.push(openId);
    } catch (e) {
      skipped.push({ openId, reason: e.message || '分发失败' });
    }
  }
  return { distributed, skipped };
}

// 列出 sourceId 这个组织共享 Provider 已经分发给哪些用户。
// 扫描全部记录，匹配 parentId=sourceId 的 owner（应是 openId）。
export function listProviderDistributions(sourceId) {
  const db = load();
  const out = [];
  for (const [pid, raw] of Object.entries(db.providers)) {
    const r = normalize(raw);
    if (r && r.parentId === sourceId && r.owner !== 'admin') {
      out.push({ openId: r.owner, copyId: pid, distributedAt: r.distributedAt, disabled: r.disabled });
    }
  }
  return out;
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