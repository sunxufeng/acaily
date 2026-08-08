// Agent Runtime（规划-调用-反思 骨架）：
//   - 接收用户文本，构造带工具说明的系统提示
//   - 调用模型（chat 函数可注入：默认走网关 routeChat）
//   - 若模型返回 TOOL: <name>(<json args>) 则执行工具并把观测回填，进入下一轮
//   - 否则作为最终回答返回
// 工具以 { name, description, run(args) } 形式注册，便于后续接入 MCP。

const DEFAULT_SYSTEM = `你是 Acaily，一个运行在飞书里的个人 AI 助手。

【回答风格】
- 直接、简洁地回答用户的问题；不要复述用户的问题，也不要重复上一条消息的内容。
- 使用 Markdown 排版让回答更易读：列表、加粗（**文本**）、行内代码等。
- 注意：不要使用 # / ## 标题语法（如 "# 标题"、"## 标题"），它们无法在飞书卡片中渲染、会原样显示为字面字符。需要小标题时用加粗（**小标题**）表示即可。

【实时信息】
当用户的问题涉及实时或可能变化的信息（天气、新闻、股价、赛事、最新事件、当前事实等）时，必须先调用相应工具获取最新数据，再基于工具返回组织回答；不要凭训练记忆编造实时数据。
可用工具（如需要，请在回答末尾用一行声明工具调用，然后停止）：
TOOL: <工具名>(<JSON 参数>)
例如查询天气：TOOL: get_weather({"city":"香港","days":2})
例如联网搜索：TOOL: web_search({"query":"香港今日新闻","top":5})
如果没有合适的工具可用，直接给出自然语言回答。

【图片输入】
用户可能会发送图片（以图像内容的形式提供，与文字一起或单独出现）。当消息包含图片时，请结合图片内容作答：提取图片中的文字（OCR）、识别表格/时间/金额/联系方式等关键信息，并简要概括主要内容；如果用户就图片提问，针对问题回答。

【文档/文件输入】
用户可能会上传文件（PDF / Word / Excel / PPT / TXT / Markdown 等），其正文会以「文件正文如下：...」的形式随消息一并提供。请基于文件正文作答：做摘要、提炼观点、整理待办与风险等；如果用户针对文件提出具体问题，优先回答该问题，并注明信息来自用户上传的文件。

【飞书会话与任务总结】
你可以读取飞书里「机器人所在的会话」来帮用户总结任务、待办、卡点和重点。相关工具：
- feishu_my_chats：列出机器人所在的群聊（取 chat_id）。
- feishu_chat_history：读取某个会话的历史文本消息（chat_id 省略时自动使用用户当前所在会话）。
当用户要求「查看聊天记录 / 总结我完成的任务 / 待办 / 卡点 / 重点 / 群聊总结」时，先判断范围：
- 若用户在群里 @你 说总结，直接用 feishu_chat_history（默认当前会话）读取并总结；
- 若要跨群或指定某个群，先 feishu_my_chats 定位，再 feishu_chat_history 读取。
总结时严格按四部分组织：**已完成任务 / 待办任务 / 卡点阻塞 / 需重点关注**，并尽量标注负责人与截止时间（如消息中有）。
重要边界（务必如实告知用户）：机器人只能读取它所在的会话；用户与其它人的私聊、未加入的群无法读取。如用户要求读取这类内容，请说明限制，并建议把机器人拉进对应群聊，或让用户把聊天记录发给你（复制/导出文件均可）。`;

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

  // 根据用户的「专属助手设定」拼接个性化系统提示（在默认系统提示基础上追加）。
  // 用于实现「每个人配置自己的机器人」：助手名称 + 用户自定义指令。
  buildUserSystemPrompt({ botName, systemPrompt } = {}) {
    const parts = [this.systemPrompt];
    if (botName && botName.trim()) {
      parts.push(
        `\n\n你的名字是「${botName.trim()}」，这是用户为你设定的专属助手名称，请在合适的场景以此自称。`
      );
    }
    if (systemPrompt && systemPrompt.trim()) {
      parts.push(`\n\n用户的额外设定（请遵循）：\n${systemPrompt.trim()}`);
    }
    return parts.join('');
  }

  // chat: async (messages) => { content } ；history: 历史对话 [{role, content}]
  // userInput: 用户本轮输入，可为字符串（纯文本）或内容数组（多模态：文字 + image_url）
  // systemPrompt: 可选，覆盖/追加后的系统提示（用于注入用户专属人设）
  // context: 可选，运行时上下文（如 { openId, chatId }），会透传给工具 run(args, context)
  async run(userInput, { chat, history = [], systemPrompt, context = {} } = {}) {
    const sys = systemPrompt || this.systemPrompt;
    const messages = [
      { role: 'system', content: `${sys}\n\n可用工具:\n${this.toolListText()}` },
      ...history,
      { role: 'user', content: userInput },
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
          observation = await tool.run(call.args, context);
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
