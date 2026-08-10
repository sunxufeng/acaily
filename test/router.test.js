import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// 必须在静态导入 userConfigStore / router 之前设置 env（模块加载时读取路径）
const tmp = mkdtempSync(join(tmpdir(), 'acaily-'));
process.env.ACAILY_MASTER_KEY = randomBytes(32).toString('hex');
process.env.ACAILY_CONFIG_STORE = join(tmp, 'configs.json');

const { setConfig } = await import('../src/config/userConfigStore.js');
const { routeChat, testConnection } = await import('../src/gateway/router.js');
const { ProviderError } = await import('../src/providers/index.js');

test('routeChat 按 open_id 路由并返回模型内容（含信封解密 API Key）', async () => {
  setConfig('ou_userA', { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-secret-xxx', model: 'gpt-4o' });
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify({ choices: [{ message: { content: '路由成功' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  });
  const r = await routeChat('ou_userA', [{ role: 'user', content: 'hi' }]);
  assert.equal(r.content, '路由成功');
  assert.equal(r.provider, 'openai');
  assert.equal(r.model, 'gpt-4o');
  assert.equal(r.attempt, 1);
});

test('未配置用户抛出 404 ProviderError', async () => {
  await assert.rejects(
    () => routeChat('ou_unknown', [{ role: 'user', content: 'hi' }]),
    (e) => e instanceof ProviderError && e.status === 404
  );
});

test('testConnection：成功与失败两种路径', async () => {
  setConfig('ou_userB', { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x', model: 'gpt-4o' });

  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: {} }),
  });
  let r = await testConnection('ou_userB');
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'openai');

  global.fetch = async () => ({
    ok: false,
    status: 500,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ error: { message: 'boom' } }),
  });
  r = await testConnection('ou_userB');
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
});

test('下游 4xx（非 429）不重试，直接抛出带 status 的错误', async () => {
  setConfig('ou_userC', { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-bad', model: 'gpt-4o' });
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return { ok: false, status: 401, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ error: { message: 'unauthorized' } }) };
  };
  await assert.rejects(
    () => routeChat('ou_userC', [{ role: 'user', content: 'hi' }]),
    (e) => e instanceof ProviderError && e.status === 401
  );
  assert.equal(calls, 1, '4xx 不应重试');
});
