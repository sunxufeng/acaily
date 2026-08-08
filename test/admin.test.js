import { test } from 'node:test';
import assert from 'node:assert/strict';
import { record, query } from '../src/audit/auditLog.js';
import { track, snapshot, reset } from '../src/admin/stats.js';
import { isAdmin } from '../src/auth/rbac.js';
import { selfAssess, COMPLIANCE_CHECKLIST } from '../src/compliance/checklist.js';

const AUDIT = '/tmp/acaily-test-audit.json';
process.env.ACAILY_AUDIT_STORE = AUDIT;

test('auditLog: 记录后按 actor/action 查询', async () => {
  await record({ actor: 'ou_a', action: 'config.update', target: 'model-config', meta: { provider: 'openai' } });
  await record({ actor: 'ou_b', action: 'chat.call', target: 'gw' });
  const a = await query({ actor: 'ou_a' });
  assert.equal(a.length, 1);
  assert.equal(a[0].action, 'config.update');
  const all = await query({ admin: true });
  assert.ok(all.length >= 2);
  const onlyChat = await query({ action: 'chat.call' });
  assert.ok(onlyChat.every((e) => e.action === 'chat.call'));
});

test('stats: 累计调用与按维度聚合', () => {
  reset();
  track({ openId: 'ou_a', provider: 'openai', tokens: 10 });
  track({ openId: 'ou_a', provider: 'openai', tokens: 20 });
  track({ openId: 'ou_b', provider: 'ollama', tokens: 5 });
  const s = snapshot();
  assert.equal(s.totalCalls, 3);
  assert.equal(s.totalTokens, 35);
  assert.equal(s.byProvider.openai, 2);
  assert.equal(s.byOpenId.ou_b, 1);
});

test('rbac: 未配置令牌默认拒绝；匹配才放行', () => {
  delete process.env.ACAILY_ADMIN_TOKEN;
  assert.equal(isAdmin({ headers: {} }), false);
  process.env.ACAILY_ADMIN_TOKEN = 'secret';
  assert.equal(isAdmin({ headers: { 'x-admin-token': 'secret' } }), true);
  assert.equal(isAdmin({ headers: { 'x-admin-token': 'wrong' } }), false);
  delete process.env.ACAILY_ADMIN_TOKEN;
});

test('compliance: 自检覆盖核心控制项', () => {
  assert.ok(COMPLIANCE_CHECKLIST.length >= 6);
  const sa = selfAssess();
  assert.ok(sa.done.length >= 6);
  assert.ok(sa.pending.includes('C7') || sa.pending.length >= 1);
});
