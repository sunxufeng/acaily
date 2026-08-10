// 用量与成本统计（T9.0 — 适配 aily「使用统计」页面）：
// 每次 chat 成功调用都会落一条事件到 data/usage.jsonl，
// 读取侧按"近 30 天"窗口聚合出 summary/byModel/trend/byUser。
//
// 数据形状：
//   {
//     ts: number,         // Date.now()
//     openId: string,
//     name?: string,      // 调用发生时若已知名字则带上（来自 userConfigStore.displayName）
//     provider: string,   // 'openai' | 'anthropic' | ...
//     model: string,
//     promptTokens: number,
//     completionTokens: number,
//   }
//
// 设计权衡：
// - jsonl 追加写 + 启动时全量加载到内存，O(1) 写入 O(N) 启动开销，最简单可靠。
// - 上限 100k 条防止极端数据膨胀（启动时裁剪）。
// - 兼容性：保留旧的 byOpenId/byProvider 聚合快照，供 /api/admin/stats 仪表盘继续使用。

import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 用量日志路径：优先取环境变量 ACAILY_USAGE_LOG；未配置时回退到项目 data/ 目录，
// 保证「开箱即用」——否则从未设置该变量的部署里 track() 永远不落盘、统计恒为空。
const USAGE_PATH =
  process.env.ACAILY_USAGE_LOG ||
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'usage.jsonl');
const MAX_EVENTS = Number(process.env.ACAILY_USAGE_MAX || 100000);

const legacy = { byOpenId: {}, byProvider: {}, total: 0, tokens: 0 };
const events = []; // ring buffer (chronological)
let loaded = false;
let dirEnsured = null;
let writing = Promise.resolve();

function dayKey(ts) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// 启动时补算旧聚合快照，使 /api/admin/stats（仪表盘）也能反映已落盘的历史数据，
// 否则只有内存里新增的事件会计入，重启后旧数据丢失。
function rehydrateLegacy() {
  for (const ev of events) {
    const inT = ev.promptTokens || 0;
    const outT = ev.completionTokens || 0;
    legacy.total += 1;
    legacy.tokens += inT + outT;
    legacy.byOpenId[ev.openId] = (legacy.byOpenId[ev.openId] || 0) + 1;
    legacy.byProvider[ev.provider] = (legacy.byProvider[ev.provider] || 0) + 1;
  }
}

async function loadAll() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await readFile(USAGE_PATH, 'utf8');
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const ev = JSON.parse(s);
        if (ev && Number.isFinite(ev.ts)) events.push(ev);
      } catch { /* 跳过残行 */ }
    }
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    rehydrateLegacy();
  } catch { /* 文件不存在视为空 */ }
}

async function persistLine(line) {
  if (!dirEnsured) dirEnsured = mkdir(dirname(USAGE_PATH), { recursive: true }).catch(() => {});
  await dirEnsured;
  // 串行写入，避免 Node 在高并发下交错
  writing = writing.then(() => appendFile(USAGE_PATH, line + '\n', 'utf8').catch(() => {}));
  return writing;
}

export async function track({
  openId = 'anon',
  name,
  provider = 'unknown',
  model = '',
  // 新字段：拆分输入/输出 token（推荐）
  promptTokens = 0,
  completionTokens = 0,
  // 旧字段兼容：直接给 token 总数；与 promptTokens/completionTokens 二选一
  tokens,
} = {}) {
  const inT = Number(promptTokens) || 0;
  const outT = Number(completionTokens) || 0;
  const totalT = Number.isFinite(Number(tokens)) ? Number(tokens) : (inT + outT);
  // 旧计数器（仪表盘依然用）
  legacy.total += 1;
  legacy.tokens += totalT;
  legacy.byOpenId[openId] = (legacy.byOpenId[openId] || 0) + 1;
  legacy.byProvider[provider] = (legacy.byProvider[provider] || 0) + 1;

  // 新事件流（只写入事件持久化，新字段优先；旧字段 tokens=0 不污染）
  const ev = {
    ts: Date.now(),
    openId: String(openId),
    name: name ? String(name).slice(0, 80) : undefined,
    provider: String(provider),
    model: String(model || '').slice(0, 120),
    // 当 caller 给了 promptTokens/completionTokens 时落盘；没有则落 0
    promptTokens: inT,
    completionTokens: outT,
  };
  events.push(ev);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  await persistLine(JSON.stringify(ev));
}

export function snapshot() {
  return {
    totalCalls: legacy.total,
    totalTokens: legacy.tokens,
    byOpenId: { ...legacy.byOpenId },
    byProvider: { ...legacy.byProvider },
  };
}

export function reset() {
  legacy.byOpenId = {}; legacy.byProvider = {}; legacy.total = 0; legacy.tokens = 0;
  events.length = 0;
}

// 聚合近 N 天的统计。range 形如 '30d'/'7d'，默认 30；调用前请 await loadAll()
export function aggregateUsage({ rangeDays = 30, now = Date.now(), userMap = {} } = {}) {
  const cutoff = now - rangeDays * 86400_000;
  const recent = events.filter((e) => e.ts >= cutoff);
  const summary = {
    totalRequests: recent.length,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    modelsUsed: 0,
    activeUsers: 0,
  };
  const byModelMap = new Map();
  const byDayMap = new Map();
  const byUserMap = new Map();

  for (const e of recent) {
    const inT = e.promptTokens || 0;
    const outT = e.completionTokens || 0;
    summary.totalTokens += inT + outT;
    summary.inputTokens += inT;
    summary.outputTokens += outT;

    const modelKey = `${e.provider || 'unknown'}::${e.model || 'default'}`;
    let m = byModelMap.get(modelKey);
    if (!m) {
      m = { provider: e.provider, model: e.model || 'default', requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      byModelMap.set(modelKey, m);
    }
    m.requests += 1; m.inputTokens += inT; m.outputTokens += outT; m.totalTokens += inT + outT;

    const dk = dayKey(e.ts);
    let d = byDayMap.get(dk);
    if (!d) { d = { date: dk, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }; byDayMap.set(dk, d); }
    d.requests += 1; d.inputTokens += inT; d.outputTokens += outT; d.totalTokens += inT + outT;

    let u = byUserMap.get(e.openId);
    if (!u) {
      u = { openId: e.openId, name: e.name || userMap[e.openId] || '', requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      byUserMap.set(e.openId, u);
    }
    u.requests += 1; u.inputTokens += inT; u.outputTokens += outT; u.totalTokens += inT + outT;
    if (u.name == null) u.name = e.name || userMap[e.openId] || '';
  }

  const byModel = [...byModelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  byModel.forEach((m, i) => { m.rank = i + 1; m.share = summary.totalTokens ? Math.round((m.totalTokens / summary.totalTokens) * 100) : 0; });
  summary.modelsUsed = byModel.filter((m) => m.totalTokens > 0).length;
  summary.activeUsers = byUserMap.size;

  // 趋势：按日期升序、补齐 rangeDays 天内所有日期（0 也填）
  const trend = [];
  for (let i = rangeDays - 1; i >= 0; i--) {
    const ts = now - i * 86400_000;
    const dk = dayKey(ts);
    const d = byDayMap.get(dk);
    trend.push(d || { date: dk, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  }

  const byUser = [...byUserMap.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  byUser.forEach((u) => { if (!u.name) u.name = userMap[u.openId] || u.openId; });

  return { rangeDays, asOf: now, summary, byModel, trend, byUser };
}

export async function ensureLoaded() {
  await loadAll();
}

// 测试辅助：清空（仅测试用）
export function _resetForTests() {
  legacy.byOpenId = {}; legacy.byProvider = {}; legacy.total = 0; legacy.tokens = 0;
  events.length = 0;
  loaded = true;
}
// 测试辅助：直接推一条事件（不写盘）
export function _pushForTests(ev) { events.push(ev); }
