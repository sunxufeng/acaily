// Agent Runtime（规划-调用-反思 骨架）：
//   - 接收用户文本，构造带工具说明的系统提示
//   - 调用模型（chat 函数可注入：默认走网关 routeChat）
//   - 若模型返回 TOOL: <name>(<json args>) 则执行工具并把观测回填，进入下一轮
//   - 否则作为最终回答返回
// 工具以 { name, description, run(args) } 形式注册，便于后续接入 MCP。

const DEFAULT_SYSTEM = `你是 Acaily，一个运行在飞书里的 AI 助手。
当用户需要调用工具时，请在回复末尾用如下格式声明一次工具调用，然后停止：
TOOL: <工具名>(<JSON 参数>)
例如：TOOL: get_weather({"city":"上海"})
如果没有合适的工具可用，直接给出自然语言回答。`;

function parseToolCall(text) {
  const m = text.match(/TOOL:\s*([A-Za-z0-9_]+)\s*\(([\s\S]*?)\)\s*$/);
  if (!m) return null;
  const raw = m[2].trim();
  let args = {};
  if (raw) {
    try {
      args = JSON.parse(raw);
    } catch {
      args = { raw };
    }
  }
  return { name: m[1], args };
}

export class AgentRuntime {
  constructor({ tools = [], maxSteps = 5, systemPrompt = DEFAULT_SYSTEM } = {}) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.maxSteps = maxSteps;
    this.systemPrompt = systemPrompt;
  }

  registerTool(tool) {
    this.tools.set(tool.name, tool);
  }

  toolListText() {
    if (this.tools.size === 0) return '（当前没有可用工具）';
    return [...this.tools.values()].map((t) => `- ${t.name}: ${t.description}`).join('\n');
  }

  // chat: async (messages) => { content } ；history: 历史对话 [{role, content}]
  async run(userText, { chat, history = [] } = {}) {
    const messages = [
      { role: 'system', content: `${this.systemPrompt}\n\n可用工具:\n${this.toolListText()}` },
      ...history,
      { role: 'user', content: userText },
    ];

    const transcript = [];
    for (let step = 0; step < this.maxSteps; step++) {
      const res = await chat(messages);
      const text = res?.content || '';
      transcript.push({ role: 'assistant', content: text });

      const call = parseToolCall(text);
      if (!call) {
        return { answer: text, transcript, steps: step + 1 };
      }

      const tool = this.tools.get(call.name);
      let observation;
      if (!tool) {
        observation = `错误：未知工具 ${call.name}`;
      } else {
        try {
          observation = await tool.run(call.args);
        } catch (e) {
          observation = `工具执行失败: ${e.message}`;
        }
      }
      transcript.push({ role: 'tool', name: call.name, content: observation });
      messages.push({ role: 'user', content: `工具 ${call.name} 返回：\n${observation}` });
    }
    return { answer: '(已达到最大步数，请简化任务或稍后重试)', transcript, steps: this.maxSteps, truncated: true };
  }
}
