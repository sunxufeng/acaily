// 自动化（T7.2）：本地 JSON 存储 + cron 表达式构造工具。
// 数据形状：
//   {
//     id: string,            // uuid
//     title: string,         // 任务名（也用作飞书卡片标题）
//     description: string,   // 提示词模板（直接作为 userInput 喂给 agent）
//     cron: string,          // 5 字段标准 cron，例如 "35 9 * * *"
//     enabled: boolean,
//     idleOnly: boolean,     // 闲时执行（00:00-06:00）开关，对齐 aily 工作台
//     pushTo: string[],      // 飞书 open_id 列表（收推送；若绑定了智能体则模型/人设来自智能体）
//     agentId: string|null,  // 关联智能体：运行其自有模型+人设，结果发到 pushTo
//     createdAt: number,
//     updatedAt: number,
//     runs: Array<{          // 最近 200 次执行记录（前端按页展示）
//       ts: number, durationMs: number, status: 'ok'|'err'|'running',
//       error?: string, preview?: string
//     }>
//   }
//
// 持久化：与 auditLog/userConfigStore 一致，写到 ACAILY_AUTOMATION_STORE
// （默认 /opt/acaily/data/automations.json），重启后由 scheduler 自动重排。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_PATH = process.env.ACAILY_AUTOMATION_STORE;
const mem = { automations: [] };

async function load() {
  if (!DEFAULT_PATH) return mem;
  try {
    const raw = await readFile(DEFAULT_PATH, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.automations)) return { automations: [] };
    return obj;
  } catch {
    return { automations: [] };
  }
}

async function save(db) {
  if (!DEFAULT_PATH) return;
  await mkdir(dirname(DEFAULT_PATH), { recursive: true });
  await writeFile(DEFAULT_PATH, JSON.stringify(db, null, 2), 'utf8');
}

function trimRuns(runs) {
  // 始终只保留最近 200 条，避免文件无限增长（前端按页展示执行记录）
  return (runs || []).slice(-200);
}

export async function listAutomations() {
  const db = await load();
  return db.automations
    .slice()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function getAutomation(id) {
  const db = await load();
  return db.automations.find((a) => a.id === id) || null;
}

// 把前端传来的收件人数组归一化为 { openId, unionId, name }，最多 32 个。
// openId/unionId 至少要有其一；用于「指定某个智能体给具体人发消息」时，
// unionId 是跨应用稳定寻址的关键。
function normalizeRecipients(arr) {
  if (!Array.isArray(arr)) return undefined;
  return arr
    .filter((r) => r && (r.openId || r.unionId))
    .slice(0, 32)
    .map((r) => ({
      openId: String(r.openId || '').trim(),
      unionId: String(r.unionId || '').trim(),
      name: String(r.name || '').trim(),
    }));
}

function normalizeCreateInput(input = {}) {
  const now = Date.now();
  // 允许调用方预设 id（如「智能体心跳」派生任务使用 hb-<agentId> 做幂等 upsert），
  // 否则生成新 uuid。
  const id = input.id ? String(input.id).slice(0, 64) : randomUUID();
  const recipients = normalizeRecipients(input.pushRecipients);
  // owner：任务创建者 open_id（系统管理员创建填管理员 open_id；普通用户自建填自己）。
  // 用于「我的自动化」视图按归属过滤，避免把其他人的任务列出来。
  const owner = String(input.owner || input.createdBy || 'system').trim();
  const pushTo = Array.isArray(input.pushTo)
    ? input.pushTo.filter(Boolean).slice(0, 32)
    : recipients
      ? recipients.map((r) => r.openId || r.unionId).filter(Boolean)
      : [];
  return {
    id,
    title: String(input.title || '未命名自动化').slice(0, 80),
    description: String(input.description || '').slice(0, 8000),
    cron: String(input.cron || '0 9 * * *').trim(),
    enabled: input.enabled !== false,
    idleOnly: !!input.idleOnly,
    agentId: input.agentId ? String(input.agentId) : null,
    pushTo,
    pushRecipients: recipients,
    maxSteps: Number.isFinite(+input.maxSteps) && +input.maxSteps > 0 ? Math.min(50, Math.floor(+input.maxSteps)) : 10,
    owner,
    // 来源标记：普通自动化任务缺省为空；由「智能体心跳」派生落地的自动化填 source='heartbeat'，
    // 用于「自动化任务菜单」按 owner/收件人过滤时不把心跳任务混进来（心跳是智能体专属，在智能体配置里管理）。
    source: input.source ? String(input.source).slice(0, 20) : '',
    // 执行结果动作：'push'（默认，把结果推送给收件人）/ 'memory'（把结果写回智能体的记忆，不发推送）。
    actionType: input.actionType === 'memory' ? 'memory' : 'push',
    createdAt: now,
    updatedAt: now,
    runs: [],
  };
}

function normalizeUpdateInput(input = {}) {
  const patch = {};
  if (typeof input.title === 'string') patch.title = input.title.slice(0, 80);
  if (typeof input.description === 'string') patch.description = input.description.slice(0, 8000);
  if (typeof input.cron === 'string') patch.cron = input.cron.trim();
  if (typeof input.enabled === 'boolean') patch.enabled = input.enabled;
  if (typeof input.idleOnly === 'boolean') patch.idleOnly = input.idleOnly;
  if ('agentId' in input) patch.agentId = input.agentId ? String(input.agentId) : null;
  if (Array.isArray(input.pushTo)) patch.pushTo = input.pushTo.filter(Boolean).slice(0, 32);
  if (Array.isArray(input.pushRecipients)) patch.pushRecipients = normalizeRecipients(input.pushRecipients);
  if (Number.isFinite(+input.maxSteps) && +input.maxSteps > 0) patch.maxSteps = Math.min(50, Math.floor(+input.maxSteps));
  if (typeof input.source === 'string') patch.source = input.source.slice(0, 20);
  if (input.actionType === 'memory' || input.actionType === 'push') patch.actionType = input.actionType;
  return patch;
}

export async function createAutomation(input) {
  const db = await load();
  const auto = normalizeCreateInput(input);
  // 记忆型（actionType='memory'）的自动化不向任何人推送，允许 pushTo 为空；其余要求至少一个收件人。
  if (auto.actionType !== 'memory' && !auto.pushTo.length) {
    throw new Error('pushTo 至少需要一个 open_id（记忆型自动化除外）');
  }
  if (!/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(auto.cron)) {
    throw new Error('cron 表达式格式错误（应为 5 字段，例如 "35 9 * * *"）');
  }
  db.automations.push(auto);
  await save(db);
  return auto;
}

export async function updateAutomation(id, input) {
  const db = await load();
  const idx = db.automations.findIndex((a) => a.id === id);
  if (idx < 0) throw new Error('自动化不存在');
  const patch = normalizeUpdateInput(input);
  if (patch.cron && !/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(patch.cron)) {
    throw new Error('cron 表达式格式错误（应为 5 字段，例如 "35 9 * * *"）');
  }
  db.automations[idx] = { ...db.automations[idx], ...patch, updatedAt: Date.now() };
  await save(db);
  return db.automations[idx];
}

export async function deleteAutomation(id) {
  const db = await load();
  const before = db.automations.length;
  db.automations = db.automations.filter((a) => a.id !== id);
  if (db.automations.length === before) return false;
  await save(db);
  return true;
}

// 追加一条运行记录（保留最近 20 条），用于「运行日志」展示。
// 写入后返回更新后的整条自动化（含最新 runs）。
export async function appendRun(id, run) {
  const db = await load();
  const auto = db.automations.find((a) => a.id === id);
  if (!auto) return null;
  auto.runs = trimRuns([...(auto.runs || []), { ts: Date.now(), ...run }]);
  auto.lastRunAt = auto.runs.length ? auto.runs[auto.runs.length - 1].ts : auto.lastRunAt;
  auto.lastRunStatus = run.status;
  auto.updatedAt = Date.now();
  await save(db);
  return auto;
}

// 按 ts 更新某条历史运行的字段（例如把「执行中」占位替换为成功 / 失败的最终结果）。
// 返回更新后的整条自动化。
export async function updateRun(id, ts, patch) {
  const db = await load();
  const auto = db.automations.find((a) => a.id === id);
  if (!auto || !Array.isArray(auto.runs)) return null;
  const idx = auto.runs.findIndex((r) => r.ts === ts);
  if (idx < 0) return null;
  auto.runs[idx] = { ...auto.runs[idx], ...patch };
  // 列表底部只认最后一条记录的 status
  const last = auto.runs[auto.runs.length - 1];
  if (last && last.status) {
    auto.lastRunStatus = last.status;
  }
  auto.updatedAt = Date.now();
  await save(db);
  return auto;
}

// 由前端「频率 + 时间」生成 5 字段 cron 表达式。
// freq: 'daily' | 'weekly' | 'monthly' | 'hourly'
// hour/minute: 0-23 / 0-59
// weeklyDay: 0-6（0=周日），仅 weekly 使用
// monthlyDay: 1-31，仅 monthly 使用
export function buildCron({ freq, hour, minute, weeklyDay, monthlyDay }) {
  const h = Number.isFinite(+hour) ? Math.min(23, Math.max(0, +hour)) : 9;
  const m = Number.isFinite(+minute) ? Math.min(59, Math.max(0, +minute)) : 35;
  switch (freq) {
    case 'weekly':
      return `${m} ${h} * * ${Math.min(6, Math.max(0, +weeklyDay || 1))}`;
    case 'monthly':
      return `${m} ${h} ${Math.min(31, Math.max(1, +monthlyDay || 1))} * *`;
    case 'hourly':
      return `${m} * * * *`;
    case 'daily':
    default:
      return `${m} ${h} * * *`;
  }
}

// 把 cron 表达式渲染成「每天 09:35」/「每周一 09:35」/「每月 1 日 09:35」的中文描述，给 UI 列表用。
export function describeCron(cron) {
  if (!cron) return '';
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [m, h, dom, , dow] = parts;
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  if (dom !== '*') return `每月 ${dom} 日 ${hh}:${mm}`;
  if (dow !== '*') {
    const names = ['日', '一', '二', '三', '四', '五', '六'];
    return `每周${names[Number(dow)] || dow} ${hh}:${mm}`;
  }
  return `每天 ${hh}:${mm}`;
}