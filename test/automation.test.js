// 自动化（T7.2）：store + cron 构造工具的单元测试。
// 测试不启动 scheduler/runner（它们依赖 agent singleton 与 fs 副作用），只覆盖
// 数据持久化、cron 表达式构造、字段校验。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const STORE = '/tmp/acaily-test-automation.json';
process.env.ACAILY_AUTOMATION_STORE = STORE;
try { fs.unlinkSync(STORE); } catch {}

const {
  createAutomation,
  updateAutomation,
  deleteAutomation,
  listAutomations,
  appendRun,
  updateRun,
  buildCron,
  describeCron,
} = await import('../src/automation/store.js');

test('store: 创建/更新/删除 + 持久化', async () => {
  const a = await createAutomation({
    title: '每日工作简报',
    description: '1. 昨天小结…',
    cron: '35 9 * * *',
    pushTo: ['ou_a', 'ou_b'],
  });
  assert.ok(a.id, '应返回 id');
  assert.equal(a.title, '每日工作简报');
  assert.equal(a.runs.length, 0);
  assert.equal(a.enabled, true);

  const list1 = await listAutomations();
  assert.equal(list1.length, 1);

  const upd = await updateAutomation(a.id, { enabled: false, idleOnly: true });
  assert.equal(upd.enabled, false);
  assert.equal(upd.idleOnly, true);

  const got = await listAutomations();
  assert.equal(got[0].enabled, false);

  const ok = await deleteAutomation(a.id);
  assert.equal(ok, true);
  const list2 = await listAutomations();
  assert.equal(list2.length, 0);
});

test('store: 字段校验 — pushTo 必填；cron 必须 5 字段', async () => {
  await assert.rejects(
    () => createAutomation({ title: 'x', description: 'x', cron: '* * *', pushTo: ['ou_a'] }),
    /cron/
  );
  await assert.rejects(
    () => createAutomation({ title: 'x', description: 'x', cron: '* * * * *', pushTo: [] }),
    /pushTo/
  );
});

test('store: appendRun 仅保留最近 200 条 + 写回 lastRunAt', async () => {
  const a = await createAutomation({
    title: 'runs',
    description: 'd',
    cron: '0 9 * * *',
    pushTo: ['ou_a'],
  });
  for (let i = 0; i < 205; i++) {
    await appendRun(a.id, { durationMs: 10 + i, status: i % 2 ? 'ok' : 'err', error: i % 2 ? undefined : 'e' });
  }
  const list = await listAutomations();
  const cur = list.find((x) => x.id === a.id);
  assert.equal(cur.runs.length, 200, '应裁剪到 200 条');
  assert.ok(cur.lastRunAt, '应写回 lastRunAt');
  assert.equal(cur.lastRunStatus, 'err', '应记录最后一次状态');
  await deleteAutomation(a.id);
});

test('buildCron: daily / weekly / monthly', () => {
  assert.equal(buildCron({ freq: 'daily', hour: 9, minute: 35 }), '35 9 * * *');
  assert.equal(buildCron({ freq: 'weekly', hour: 8, minute: 0, weeklyDay: 1 }), '0 8 * * 1');
  assert.equal(buildCron({ freq: 'monthly', hour: 7, minute: 30, monthlyDay: 15 }), '30 7 15 * *');
  // 越界值应被夹紧，不应崩
  assert.equal(buildCron({ freq: 'daily', hour: 99, minute: 999 }), '59 23 * * *');
});

test('describeCron: 中文渲染', () => {
  assert.equal(describeCron('35 9 * * *'), '每天 09:35');
  assert.equal(describeCron('0 8 * * 1'), '每周一 08:00');
  assert.equal(describeCron('30 7 15 * *'), '每月 15 日 07:30');
  assert.equal(describeCron('bogus'), 'bogus', '非法表达式原样返回');
});

test('store: updateRun 把「执行中」占位 in-place 替换为最终结果（解决 UI 一直显示执行中 0ms）', async () => {
  const a = await createAutomation({
    title: 'in-place',
    description: 'd',
    cron: '0 9 * * *',
    pushTo: ['ou_a'],
  });
  // 模拟：先 append 一条 running 占位
  const placeholderTs = Date.now();
  await appendRun(a.id, { ts: placeholderTs, durationMs: 0, status: 'running' });
  // 等几毫秒避免 ts 碰撞
  await new Promise((r) => setTimeout(r, 5));
  // 然后用 updateRun 把同一行改成 ok + 真实 duration
  const upd = await updateRun(a.id, placeholderTs, {
    durationMs: 4321,
    status: 'ok',
    preview: '你好，世界',
  });
  assert.ok(upd, 'updateRun 应返回更新后的 auto');
  const target = upd.runs.find((r) => r.ts === placeholderTs);
  assert.ok(target, '应找到原占位行');
  assert.equal(target.status, 'ok');
  assert.equal(target.durationMs, 4321);
  assert.equal(target.preview, '你好，世界');
  // 没有产生第二条运行记录（in-place，不 append）
  assert.equal(upd.runs.length, 1);
  await deleteAutomation(a.id);
});

test('store: updateRun 找不到 ts 时返回 null（兜底——旧数据不会有 ts 碰撞）', async () => {
  const a = await createAutomation({
    title: 'not-found',
    description: 'd',
    cron: '0 9 * * *',
    pushTo: ['ou_a'],
  });
  const r = await updateRun(a.id, 12345, { status: 'ok' });
  assert.equal(r, null);
  // 完全不存在的自动化
  const r2 = await updateRun('ghost', 0, { status: 'ok' });
  assert.equal(r2, null);
  await deleteAutomation(a.id);
});

test('cleanup', () => {
  try { fs.unlinkSync(STORE); } catch {}
});
test('createAutomation/maxSteps 持久化：默认 10，传入 20 则存为 20', async () => {
  const def = await createAutomation({
    title: '默认步数', description: 'd', cron: '0 8 * * *', pushTo: ['ou_x'],
  });
  assert.equal(def.maxSteps, 10);
  const big = await createAutomation({
    title: '大步数', description: 'd', cron: '0 8 * * *', pushTo: ['ou_x'], maxSteps: 20,
  });
  assert.equal(big.maxSteps, 20);
  // updateAutomation 也允许覆盖
  const upd = await updateAutomation(def.id, { maxSteps: 5 });
  assert.equal(upd.maxSteps, 5);
  // 非法值会被规整到 50 上限
  const cap = await createAutomation({
    title: '上限', description: 'd', cron: '0 8 * * *', pushTo: ['ou_x'], maxSteps: 999,
  });
  assert.equal(cap.maxSteps, 50);
});
