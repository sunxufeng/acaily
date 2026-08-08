// MCP（Model Context Protocol）客户端：让 Agent 能调用外部技能/工具（T3.2）
// 实现 JSON-RPC 2.0 over stdio（生产）与可注入的 Mock（测试）。
import { spawn } from 'node:child_process';

let RPC_ID = 1;

/** 基础 JSON-RPC 传输层：子类实现 _send(raw) 与 _onMessage(cb) */
class JsonRpcTransport {
  constructor() { this._handlers = []; this._pending = new Map(); }
  _onMessage(cb) { this._handlers.push(cb); }
  _emit(obj) {
    if (obj.id != null && this._pending.has(obj.id)) {
      const { resolve, reject } = this._pending.get(obj.id);
      this._pending.delete(obj.id);
      if (obj.error) reject(new Error(obj.error.message || JSON.stringify(obj.error)));
      else resolve(obj.result);
    }
    this._handlers.forEach((h) => h(obj));
  }
  request(method, params = {}) {
    const id = RPC_ID++;
    const msg = { jsonrpc: '2.0', id, method, params };
    const p = new Promise((resolve, reject) => this._pending.set(id, { resolve, reject }));
    this._send(JSON.stringify(msg));
    return p;
  }
  // 子类实现
  _send() { throw new Error('not implemented'); }
  close() {}
}

/** stdio 传输：启动 MCP server 子进程，按行收发包 */
export class StdioTransport extends JsonRpcTransport {
  constructor(command, args = [], env = {}) {
    super();
    this.proc = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) { try { this._emit(JSON.parse(line)); } catch {} }
      }
    });
    this.proc.stderr.on('data', (d) => process.stderr.write(`[mcp] ${d}`));
  }
  _send(raw) { this.proc.stdin.write(raw + '\n'); }
  close() { try { this.proc.kill(); } catch {} }
}

/** 测试用 mock 传输 */
export class MockTransport extends JsonRpcTransport {
  constructor(handler) { super(); this.handler = handler; }
  _send(raw) {
    const { id, method, params } = JSON.parse(raw);
    Promise.resolve(this.handler(method, params)).then((result) =>
      this._emit({ jsonrpc: '2.0', id, result }));
  }
}

export class McpClient {
  constructor(transport) { this.t = transport; this.tools = []; }
  async initialize() {
    await this.t.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {}, clientInfo: { name: 'acaily', version: '0.1.0' },
    });
    this.tools = await this.listTools();
    return this.tools;
  }
  async listTools() {
    const r = await this.t.request('tools/list', {});
    this.tools = r.tools || [];
    return this.tools;
  }
  async callTool(name, args = {}) {
    const r = await this.t.request('tools/call', { name, arguments: args });
    // MCP 返回 content 数组，统一抽出文本
    const text = (r.content || []).map((c) => (c.type === 'text' ? c.text : '')).join('');
    return { text, raw: r };
  }
  close() { this.t.close(); }
}

/** 把 MCP 工具适配为 Agent Runtime 的工具接口 */
export function toAgentTool(client, toolDef) {
  return {
    name: toolDef.name,
    description: toolDef.description || '',
    run: async (args) => {
      const r = await client.callTool(toolDef.name, args || {});
      return r.text;
    },
  };
}
