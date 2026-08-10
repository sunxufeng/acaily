// 自动化（T7.2）：cron 调度生命周期。
// 把每条自动化挂到一个 croner 实例上，启动时全量 reschedule；
// 增删改时按 id 增量调度。handler 把执行交给 runner。

import { Cron } from 'croner';
import { listAutomations, getAutomation } from './store.js';
import { runAutomation } from './runner.js';

const jobs = new Map(); // id -> Cron instance
const deferred = new Map(); // id -> Timeout（idleOnly 模式的延时执行）

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
  const t = deferred.get(id);
  if (t) {
    clearTimeout(t);
    deferred.delete(id);
  }
}

// 触发：执行前再读一次 store（避免 runner 拿到旧 enabled 状态），然后交给 runner
async function onFire(id) {
  const auto = await getAutomation(id);
  if (!auto) return unscheduleOne(id);
  if (auto.enabled === false) return;
  if (auto.idleOnly) {
    const hr = new Date().getHours();
    if (hr >= 6 || hr < 0) {
      // 当前不在 00:00-06:00 窗口 → 延后到下一个 00:00
      const delay = msUntilNextMidnight();
      const t = setTimeout(() => {
        deferred.delete(id);
        // 时间到了再读一次配置（可能已被关停/删除）
        getAutomation(id).then((cur) => {
          if (!cur || cur.enabled === false) return;
          runAutomation(cur).catch((e) => console.error('[automation] idle-run error:', e.message));
        });
      }, delay);
      deferred.set(id, t);
      return;
    }
  }
  runAutomation(auto).catch((e) => console.error('[automation] run error:', e.message));
}

function msUntilNextMidnight() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next.getTime() - now.getTime();
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