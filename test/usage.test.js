// T9.0 — usage 统计聚合单元测试（参考 aily「使用统计」）
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
// 隔离测试落盘路径，避免污染项目 data/ 目录（与 audit 测试同理）。
// 必须在 import stats.js 之前设置，故使用动态 import（ESM 静态 import 会被提升、读不到此 env）。
process.env.ACAILY_USAGE_LOG = '/tmp/acaily-test-usage.jsonl';
rmSync(process.env.ACAILY_USAGE_LOG, { force: true });
const { _resetForTests, _pushForTests, aggregateUsage, track, snapshot, ensureLoaded } = await import('../src/admin/stats.js');

test('aggregateUsage: 空事件流返回 0/0', async () => {
  await ensureLoaded();
  _resetForTests();
  const r = aggregateUsage({ rangeDays: 30 });
  assert.equal(r.summary.totalRequests, 0);
  assert.equal(r.summary.totalTokens, 0);
  assert.equal(r.summary.activeUsers, 0);
  assert.equal(r.byModel.length, 0);
  // 即使没有事件也按天数补齐 30 个日期桶
  assert.equal(r.trend.length, 30);
});

test('track: 写入事件流并被聚合到 byModel / byUser / trend', async () => {
  _resetForTests();
  await ensureLoaded();
  const now = Date.UTC(2026, 7, 9, 10, 0, 0); // 2026-08-09
  // 3 条同模型 + 1 条不同模型 + 1 条不同用户
  _pushForTests({ ts: now - 1 * 86400_000, openId: 'ou_a', name: 'A', provider: 'openai', model: 'gpt-4o', promptTokens: 100, completionTokens: 300 });
  _pushForTests({ ts: now, openId: 'ou_a', name: 'A', provider: 'openai', model: 'gpt-4o', promptTokens: 200, completionTokens: 600 });
  _pushForTests({ ts: now, openId: 'ou_b', name: 'B', provider: 'openai', model: 'gpt-4o', promptTokens: 150, completionTokens: 450 });
  _pushForTests({ ts: now, openId: 'ou_a', name: 'A', provider: 'anthropic', model: 'claude-3-5-sonnet', promptTokens: 50, completionTokens: 150 });
  // 太老的（>30 天前）应当被剔除
  _pushForTests({ ts: now - 60 * 86400_000, openId: 'ou_old', name: 'Old', provider: 'openai', model: 'gpt-4o', promptTokens: 99999, completionTokens: 99999 });

  const r = aggregateUsage({ rangeDays: 30, now });
  assert.equal(r.summary.totalRequests, 4, '应剔除 60 天前那条');
  assert.equal(r.summary.totalTokens, 100 + 300 + 200 + 600 + 150 + 450 + 50 + 150);
  assert.equal(r.summary.inputTokens, 100 + 200 + 150 + 50);
  assert.equal(r.summary.outputTokens, 300 + 600 + 450 + 150);
  assert.equal(r.summary.activeUsers, 2);
  assert.equal(r.byModel.length, 2, 'openai/gpt-4o + anthropic/claude-3-5-sonnet');
  assert.equal(r.byModel[0].totalTokens, 1800, 'gpt-4o 总量更高，排在前面');
  // userMap 会回填
  assert.equal(r.byUser[0].openId, 'ou_a');
  // trend 长度 = 30
  assert.equal(r.trend.length, 30);
});

test('track: promptTokens/completionTokens 单独记录', async () => {
  _resetForTests();
  await track({ openId: 'ou_x', name: 'X', provider: 'openai', model: 'gpt-4o-mini', promptTokens: 450, completionTokens: 1700 });
  const r = aggregateUsage({ rangeDays: 30 });
  assert.equal(r.summary.inputTokens, 450);
  assert.equal(r.summary.outputTokens, 1700);
  assert.equal(r.summary.totalTokens, 2150);
});

test('snapshot: 旧接口兼容（仪表盘用）', async () => {
  _resetForTests();
  await track({ openId: 'ou_y', provider: 'openai', tokens: 0 });
  await track({ openId: 'ou_y', provider: 'acplugin', tokens: 0 });
  const snap = snapshot();
  assert.equal(snap.totalCalls, 2);
  assert.equal(snap.byOpenId['ou_y'], 2);
  assert.equal(snap.byProvider.openai, 1);
  assert.equal(snap.byProvider.acplugin, 1);
});
