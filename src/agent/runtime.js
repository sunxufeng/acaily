// Agent Runtime（规划-调用-反思 骨架）：
//   - 接收用户文本，构造带工具说明的系统提示
//   - 调用模型（chat 函数可注入：默认走网关 routeChat）
//   - 若模型返回 TOOL: <name>(<json args>) 则执行工具并把观测回填，进入下一轮
//   - 否则作为最终回答返回
// 工具以 { name, description, run(args) } 形式注册，便于后续接入 MCP。

const DEFAULT_SYSTEM = `你是 Acaily，一个运行在飞书里的个人 AI 助手。

【回答风格】
- 直接、简洁地回答用户的问题；不要复述用户的问题，也不要重复上一条消息的内容。
- 使用 Markdown 排版（标题、列表、加粗、代码块等）让回答更易读。

【实时信息】
当用户的问题涉及实时或可能变化的信息（天气、新闻、股价、赛事、最新事件、当前事实等）时，必须先调用相应工具获取最新数据，再基于工具返回组织回答；不要凭训练记忆编造实时数据。
可用工具（如需要，请在回答末尾用一行声明工具调用，然后停止）：
TOOL: <工具名>(<JSON 参数>)
例如查询天气：TOOL: get_weather({"city":"香港","days":2})
例如联网搜索：TOOL: web_search({"query":"香港今日新闻","top":5})
如果没有合适的工具可用，直接给出自然语言回答。`;

// 从模型输出里剥离工具声明行（避免把 TOOL: ... 透传给用户）
export function stripToolLines(text) {
  if (!text) return text;
  return text
    .split('\n')
    .filter((l) => !/^\s*TOOL:\s*[A-Za-z0-9_]+\s*\(/.test(l))
    .join('\n')
    .trim();
}

function parseToolCall(text) {
  // 匹配任意位置的 TOOL: 声明（不要求必须在结尾）
  const m = text.match(/TOOL:\s*([A-Za-z0-9_]+)\s*\(([\s\S]*?)\)/);
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
        return { answer: stripToolLines(text), transcript, steps: step + 1 };
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
