import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateUserModelConfig } from '../src/config/schema.js';

const base = {
  provider: 'openai',
  baseUrl: 'https://api.example.com/v1',
  model: 'm',
  apiKey: 'k',
};

test('基础合法配置通过', () => {
  assert.equal(validateUserModelConfig(base).length, 0);
});

test('topP 必须在 [0,1]', () => {
  assert.ok(validateUserModelConfig({ ...base, topP: -0.1 }).length > 0);
  assert.ok(validateUserModelConfig({ ...base, topP: 1.5 }).length > 0);
  assert.equal(validateUserModelConfig({ ...base, topP: 0 }).length, 0);
  assert.equal(validateUserModelConfig({ ...base, topP: 1 }).length, 0);
  assert.equal(validateUserModelConfig({ ...base, topP: '0.95' }).length, 0);
  assert.equal(validateUserModelConfig({ ...base, topP: '' }).length, 0);
});

test('topK 必须是正整数', () => {
  assert.ok(validateUserModelConfig({ ...base, topK: 0 }).length > 0);
  assert.ok(validateUserModelConfig({ ...base, topK: 1.5 }).length > 0);
  assert.equal(validateUserModelConfig({ ...base, topK: 10 }).length, 0);
  assert.equal(validateUserModelConfig({ ...base, topK: '' }).length, 0);
});

test('frequency/presence penalty 必须在 [-2,2]', () => {
  assert.ok(validateUserModelConfig({ ...base, frequencyPenalty: -2.1 }).length > 0);
  assert.ok(validateUserModelConfig({ ...base, frequencyPenalty: 2.5 }).length > 0);
  assert.equal(validateUserModelConfig({ ...base, frequencyPenalty: 2 }).length, 0);
  assert.ok(validateUserModelConfig({ ...base, presencePenalty: -3 }).length > 0);
  assert.equal(validateUserModelConfig({ ...base, presencePenalty: -2 }).length, 0);
});

test('stream / multimodal 必须是布尔', () => {
  assert.equal(validateUserModelConfig({ ...base, stream: true }).length, 0);
  assert.equal(validateUserModelConfig({ ...base, stream: false }).length, 0);
  assert.equal(validateUserModelConfig({ ...base, multimodal: true }).length, 0);
  assert.ok(validateUserModelConfig({ ...base, stream: 'yes' }).length > 0);
  assert.ok(validateUserModelConfig({ ...base, multimodal: 1 }).length > 0);
});

test('timeout 1..600 秒', () => {
  assert.ok(validateUserModelConfig({ ...base, timeout: 0 }).length > 0);
  assert.ok(validateUserModelConfig({ ...base, timeout: 700 }).length > 0);
  assert.equal(validateUserModelConfig({ ...base, timeout: 90 }).length, 0);
  assert.equal(validateUserModelConfig({ ...base, timeout: '' }).length, 0);
});

test('retries 0..5', () => {
  assert.ok(validateUserModelConfig({ ...base, retries: -1 }).length > 0);
  assert.ok(validateUserModelConfig({ ...base, retries: 6 }).length > 0);
  assert.equal(validateUserModelConfig({ ...base, retries: 0 }).length, 0);
  assert.equal(validateUserModelConfig({ ...base, retries: 5 }).length, 0);
});

test('customHeaders 必须是合法对象', () => {
  assert.equal(validateUserModelConfig({ ...base, customHeaders: { 'X-Tid': 'a' } }).length, 0);
  assert.equal(validateUserModelConfig({ ...base, customHeaders: { 'X-Trace-Id': 't-1' } }).length, 0);
  assert.ok(validateUserModelConfig({ ...base, customHeaders: ['x'] }).length > 0, '数组非法');
  assert.ok(validateUserModelConfig({ ...base, customHeaders: 'x' }).length > 0, '字符串非法');
  assert.ok(validateUserModelConfig({ ...base, customHeaders: { 'bad key': 'a' } }).length > 0, '键名空格非法');
  assert.ok(validateUserModelConfig({ ...base, customHeaders: { 'X-Tid': '' } }).length > 0, '空值非法');
  assert.equal(validateUserModelConfig({ ...base, customHeaders: null }).length, 0, 'null 等同于跳过');
});

test('models 数组元素必须是字符串', () => {
  assert.equal(validateUserModelConfig({ ...base, models: ['a', 'b'] }).length, 0);
  assert.ok(validateUserModelConfig({ ...base, models: ['a', ''] }).length > 0);
  assert.ok(validateUserModelConfig({ ...base, models: ['a', 1] }).length > 0);
  assert.ok(validateUserModelConfig({ ...base, models: 'a' }).length > 0);
});

test('configName 长度上限 60', () => {
  assert.equal(validateUserModelConfig({ ...base, configName: '我的 OpenAI' }).length, 0);
  assert.ok(validateUserModelConfig({ ...base, configName: 'x'.repeat(61) }).length > 0);
});

test('ollama 不强制 apiKey', () => {
  const o = { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen2.5:7b' };
  assert.equal(validateUserModelConfig(o).length, 0);
});
