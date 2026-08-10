import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProvider, ProviderError } from '../src/providers/index.js';
import { DEFAULT_ACPLUGIN_BASEURL } from '../src/providers/acplugin.js';

function mockFetch(jsonBody, { ok = true, status = 200, headers = {} } = {}) {
  global.fetch = async () => ({
    ok,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] || headers[k] || null },
    text: async () => JSON.stringify(jsonBody),
  });
}

test('openai 兼容：解析 choices/message/content + usage', async () => {
  mockFetch({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } });
  const p = getProvider({ type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'x', model: 'gpt-4o' });
  const r = await p.chat([{ role: 'user', content: 'hello' }]);
  assert.equal(r.content, 'hi');
  assert.deepEqual(r.usage, { promptTokens: 5, completionTokens: 3 });
});

test('anthropic：解析 content 数组 + usage', async () => {
  mockFetch({ content: [{ type: 'text', text: 'bonjour' }], usage: { input_tokens: 4, output_tokens: 2 } });
  const p = getProvider({ type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'x', model: 'claude-3' });
  const r = await p.chat([{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }]);
  assert.equal(r.content, 'bonjour');
  assert.deepEqual(r.usage, { promptTokens: 4, completionTokens: 2 });
});

test('ollama：解析 message.content + eval 计数', async () => {
  mockFetch({ message: { content: '本地回复' }, prompt_eval_count: 6, eval_count: 4 });
  const p = getProvider({ type: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3' });
  const r = await p.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(r.content, '本地回复');
  assert.deepEqual(r.usage, { promptTokens: 6, completionTokens: 4 });
});

test('custom：可配置 chat/completions 路径', async () => {
  mockFetch({ choices: [{ message: { content: 'ok' } }], usage: {} });
  const p = getProvider({ type: 'custom', baseUrl: 'https://gw.internal', chatCompletionsPath: '/v1/chat', apiKey: 'x', model: 'm' });
  const r = await p.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(r.content, 'ok');
});

test('http 非 200 抛 ProviderError 并带 status', async () => {
  mockFetch({ error: { message: 'invalid api key' } }, { ok: false, status: 401 });
  const p = getProvider({ type: 'openai', baseUrl: 'https://x', apiKey: 'bad', model: 'm' });
  await assert.rejects(
    () => p.chat([{ role: 'user', content: 'hi' }]),
    (e) => e instanceof ProviderError && e.status === 401
  );
});

test('未知 provider 类型抛错', () => {
  assert.throws(() => getProvider({ type: 'unknown', baseUrl: 'x', model: 'm' }), ProviderError);
});

test('acplugin：默认 base URL 命中 acplugin 网关 /api/chat/completions', async () => {
  let calledUrl = '';
  global.fetch = async (url) => {
    calledUrl = url;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ choices: [{ message: { content: 'Acplugin回复' } }], usage: {} }),
    };
  };
  const p = getProvider({ type: 'acplugin', apiKey: 'x', model: 'hunyuan' });
  const r = await p.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(r.content, 'Acplugin回复');
  assert.equal(calledUrl, DEFAULT_ACPLUGIN_BASEURL + '/chat/completions');
});

test('错误提示：401 给出 API Key 排查提示', async () => {
  mockFetch({ error: { message: 'Unauthorized' } }, { ok: false, status: 401 });
  const p = getProvider({ type: 'openai', baseUrl: 'https://x', apiKey: 'bad', model: 'm' });
  await assert.rejects(
    () => p.chat([{ role: 'user', content: 'hi' }]),
    (e) => /API Key/.test(e.message) && e.status === 401
  );
});

test('错误提示：429 给出限流/额度提示', async () => {
  mockFetch({ error: { message: 'Too Many Requests' } }, { ok: false, status: 429 });
  const p = getProvider({ type: 'openai', baseUrl: 'https://x', apiKey: 'x', model: 'm' });
  await assert.rejects(
    () => p.chat([{ role: 'user', content: 'hi' }]),
    (e) => /额度|频繁/.test(e.message) && e.status === 429
  );
});

// === 流式响应（SSE）===
import { parseSseResponse } from '../src/providers/base.js';

// 构造一个 ReadableStream，模拟 SSE 多 chunk + [DONE] 结束
function sseReadable(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(enc.encode(c));
      ctrl.close();
    },
  });
}

test('SSE：解析 OpenAI 兼容协议的多 chunk 回复', async () => {
  const events = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"你好"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"，世界"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"！"}}],"usage":{"prompt_tokens":5,"completion_tokens":4,"total_tokens":9}}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const res = {
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    body: sseReadable([events]),
  };
  const data = await parseSseResponse(res);
  assert.equal(data.choices[0].message.content, '你好，世界！');
  assert.equal(data.usage.prompt_tokens, 5);
  assert.equal(data.usage.completion_tokens, 4);
});

test('SSE：流式 + openai provider 应该获得完整文本（不是空内容）', async () => {
  const events = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"Acaily 在的"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"，请讲"}}]}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    body: sseReadable([events]),
  });
  const p = getProvider({ type: 'openai', baseUrl: 'https://x', apiKey: 'x', model: 'gpt-4o', stream: true });
  const r = await p.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(r.content, 'Acaily 在的，请讲');
});

test('SSE：无 reader 时降级读 text 并包装成回复', async () => {
  // 极端兜底：body 是个 ReadableStream 但 getReader 不存在的旧运行时
  const res = {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    body: null,
    text: async () => 'plain text fallback',
  };
  const data = await parseSseResponse(res);
  assert.equal(data.choices[0].message.content, 'plain text fallback');
});
