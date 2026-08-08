import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, appendMessage, getHistory, listSessions } from '../src/config/conversationStore.js';

const STORE = '/tmp/acaily-test-conv.json';
process.env.ACAILY_CONV_STORE = STORE;

test('conversation store: 创建/追加/读取/租户隔离', async () => {
  const sid = await createSession('ou_alice', 'hello');
  await appendMessage(sid, 'user', '你好');
  await appendMessage(sid, 'assistant', '你好，我是 Acaily');

  const hist = await getHistory('ou_alice', sid);
  assert.equal(hist.length, 2);
  assert.equal(hist[0].role, 'user');
  assert.equal(hist[1].content, '你好，我是 Acaily');

  // 跨用户越权访问应返回 null（租户隔离）
  const cross = await getHistory('ou_bob', sid);
  assert.equal(cross, null);

  const sessions = await listSessions('ou_alice');
  assert.ok(sessions.find((s) => s.id === sid));
});

test('conversation store: 不存在的会话返回 null', async () => {
  const r = await getHistory('ou_x', 'nonexistent');
  assert.equal(r, null);
});
