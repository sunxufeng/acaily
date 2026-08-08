import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpClient, MockTransport, toAgentTool } from '../src/mcp/client.js';

// 模拟一个 MCP server：tools/list + tools/call(get_weather)
function mockHandler(method, params) {
  if (method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: {} };
  if (method === 'tools/list') return { tools: [{ name: 'get_weather', description: '查天气', inputSchema: {} }] };
  if (method === 'tools/call') {
    assert.equal(params.name, 'get_weather');
    return { content: [{ type: 'text', text: `天气：${params.arguments.city} 晴` }] };
  }
  return {};
}

test('McpClient: initialize 列出工具', async () => {
  const client = new McpClient(new MockTransport(mockHandler));
  const tools = await client.initialize();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'get_weather');
});

test('McpClient: callTool 返回文本', async () => {
  const client = new McpClient(new MockTransport(mockHandler));
  await client.initialize();
  const r = await client.callTool('get_weather', { city: '上海' });
  assert.equal(r.text, '天气：上海 晴');
});

test('toAgentTool: 适配为 Agent 工具接口', async () => {
  const client = new McpClient(new MockTransport(mockHandler));
  await client.initialize();
  const tool = toAgentTool(client, client.tools[0]);
  const out = await tool.run({ city: '北京' });
  assert.equal(out, '天气：北京 晴');
});
