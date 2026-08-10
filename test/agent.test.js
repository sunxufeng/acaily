import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent/runtime.js';

test('无工具调用时直接返回回答', async () => {
  const rt = new AgentRuntime({ tools: [] });
  const r = await rt.run('你好', { chat: async () => ({ content: '你好，有什么可以帮你？' }) });
  assert.equal(r.answer, '你好，有什么可以帮你？');
  assert.equal(r.steps, 1);
});

test('模型声明工具调用 -> 执行工具 -> 返回最终答案', async () => {
  let calls = 0;
  const rt = new AgentRuntime({
    tools: [{ name: 'get_time', description: '获取时间', run: async () => '2026-08-08T12:00:00Z' }],
  });
  const chat = async () => {
    calls++;
    if (calls === 1) return { content: 'TOOL: get_time({})' };
    return { content: '现在时间是 2026-08-08T12:00:00Z' };
  };
  const r = await rt.run('现在几点', { chat });
  assert.equal(calls, 2);
  assert.equal(r.answer, '现在时间是 2026-08-08T12:00:00Z');
  assert.equal(r.transcript.length, 3); // assistant(toolcall) + tool + assistant(final)
});

test('未知工具被安全处理，不中断流程', async () => {
  const rt = new AgentRuntime({ tools: [] });
  let calls = 0;
  const chat = async () => {
    calls++;
    return calls === 1 ? { content: 'TOOL: nope({})' } : { content: '我无法调用该工具' };
  };
  const r = await rt.run('x', { chat });
  const toolStep = r.transcript.find((t) => t.role === 'tool');
  assert.ok(toolStep);
  assert.match(toolStep.content, /未知工具 nope/);
  assert.equal(r.answer, '我无法调用该工具');
});

test('maxSteps 覆盖：传入 maxSteps=3 时，到第 4 步仍返回最大步数提示', async () => {
  // 模型永远只回 TOOL，从而把每一步都耗在工具调用上
  const rt = new AgentRuntime({
    tools: [{ name: 'noop', description: 'noop', run: async () => 'obs' }],
    maxSteps: 2,
  });
  const chat = async () => ({ content: 'TOOL: noop({})' });
  const r = await rt.run('x', { chat, maxSteps: 3 });
  assert.equal(r.steps, 3);
  assert.match(r.answer, /已达到最大步数/);
});

test('maxSteps 覆盖：未传时沿用构造时的 maxSteps', async () => {
  const rt = new AgentRuntime({
    tools: [{ name: 'noop', description: 'noop', run: async () => 'obs' }],
    maxSteps: 2,
  });
  const chat = async () => ({ content: 'TOOL: noop({})' });
  const r = await rt.run('x', { chat });
  assert.equal(r.steps, 2);
  assert.match(r.answer, /已达到最大步数/);
});
