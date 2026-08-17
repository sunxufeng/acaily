// 自动化（T7.2）：cron 调度生命周期。
// 把每条自动化挂到一个 croner 实例上，启动时全量 reschedule；
// 增删改时按 id 增量调度。handler 把执行交给 runner。

import { Cron } from 'croner';
import fs from 'node:fs';
import path from 'node:path';
import { listAutomations, getAutomation } from './store.js';
import { runAutomation } from './runner.js';

const jobs = new Map(); // id -> Cron instance

// 闲时执行（idleOnly）待办队列：持久化到磁盘，避免内存 setTimeout 在服务重启/崩溃时丢失。
// 结构：[{ id: automationId, runAt: 目标执行时间戳(ms) }]
const STORE_PATH = process.env.ACAILY_AUTOMATION_STORE || '/opt/acaily/data/automations.json';
const DATA_DIR = path.dirname(STORE_PATH);
const PENDING_FILE = path.join(DATA_DIR, 'pendingIdle.json');

let pending = loadPending();
let sweepTimer = null;

function loadPending() {
  try {
    const arr = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8') || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function savePending() {
  try {
    fs.writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2));
  } catch (e) {
    console.error('[automation] 保存闲时待办失败:', e.message);
  }
}
function addPending(id, runAt) {
  if (!pending.find((p) => p.id === id)) {
    pending.push({ id, runAt });
    savePending();
  }
}

// 启动时调用：把全部 enabled 的自动化挂上 cron
export async function scheduleAll() {
  const autos = await listAutomations();
  let scheduled = 0;
  for (const a of autos) {
    if (a.enabled !== false) {
      scheduleOne(a);
      scheduled++;
    }
  }
  startSweep();
  // 启动即补跑已过期的闲时任务（容忍重启：即使重启发生在 9:00~次日00:00 之间也不丢）
  await sweepPendingIdle();
  return { total: autos.length, scheduled };
}

// 单条调度：覆盖式（同 id 重复调度不会泄漏 job）
export function scheduleOne(auto) {
  unscheduleOne(auto.id);
  if (!auto || auto.enabled === false) return;
  if (!auto.cron) return;
  try {
    const job = new Cron(auto.cron, { name: `automation:${auto.id}`, protect: true }, () => onFire(auto.id));
    jobs.set(auto.id, job);
  } catch (e) {
    console.error(`[automation] 调度失败 (${auto.title}):`, e.message);
  }
}

export function unscheduleOne(id) {
  const job = jobs.get(id);
  if (job) {
    try { job.stop(); } catch {}
    jobs.delete(id);
  }
  // 注意：不要在 unschedule 时清除 pending，否则重启/编辑自动化会丢失待执行的闲时任务。
  // pending 只在该任务被禁用/删除时（onFire / 删除接口）才清除。
}

// 显式清除某任务的闲时待办（禁用/删除时使用）
export function removePending(id) {
  const before = pending.length;
  pending = pending.filter((p) => p.id !== id);
  if (pending.length !== before) savePending();
}

// 触发：执行前再读一次 store（避免 runner 拿到旧 enabled 状态），然后交给 runner
async function onFire(id) {
  const auto = await getAutomation(id);
  if (!auto) {
    removePending(id);
    return unscheduleOne(id);
  }
  if (auto.enabled === false) {
    removePending(id);
    return;
  }
  if (auto.idleOnly) {
    const hr = new Date().getHours();
    if (hr >= 6) {
      // 当前不在 00:00-06:00 空闲窗口 → 记录待执行，等到下一个 00:00 由 sweeper 触发（落盘，不怕重启）
      addPending(id, nextIdleWindowStart());
      return;
    }
  }
  runAutomation(auto).catch((e) => console.error('[automation] run error:', e.message));
}

// 下一个空闲窗口起点（次日 00:00）
function nextIdleWindowStart() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0); // 今天 24:00 = 次日 00:00
  return next.getTime();
}

// 周期/启动补跑：执行所有已到点的闲时待办
async function sweepPendingIdle() {
  if (!pending.length) return;
  const now = Date.now();
  const due = pending.filter((p) => p.runAt <= now);
  if (!due.length) return;
  // 先移除，避免重复触发（即使本次执行较慢也不会被下次 sweep 再跑）
  pending = pending.filter((p) => p.runAt > now);
  savePending();
  for (const p of due) {
    const auto = await getAutomation(p.id);
    if (!auto || auto.enabled === false) continue;
    await runAutomation(auto).catch((e) => console.error('[automation] idle-run error:', e.message));
  }
}

function startSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweepPendingIdle().catch(() => {});
  }, 60_000);
}

// 给 API 层「立即运行」按钮用：异步执行，不阻塞 HTTP 响应
export async function triggerNow(id) {
  const auto = await getAutomation(id);
  if (!auto) throw new Error('自动化不存在');
  // 异步执行（fire & forget），调用方不必 await；由 runner 内部落日志
  runAutomation(auto, { manual: true }).catch((e) => console.error('[automation] manual-run error:', e.message));
  return { ok: true };
}

export function activeJobCount() {
  return jobs.size;
}
