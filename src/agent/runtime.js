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
例如读取并总结一个网页链接：TOOL: web_read({"url":"https://example.com/article"})
当用户发来一个网页链接并希望「总结/翻译/解读这篇」时，先用 web_read 抓取正文再作答，不要凭空编造。
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
【身份锚定（最关键）】工具会在返回**开头**标注「【身份锚定】当前飞书用户 = <真实姓名>（open_id: ...）」。请**严格以该标注身份为唯一锚点**：只有消息里以「【你｜<姓名>】」开头、或 @ 给该用户的任务，才计入「我的任务」；群内其他成员（如王俏谊等）的任务**绝不**算到该用户头上，即使该成员在群里的任务很多。判断归属依据：①消息里明确写「<姓名> 负责 / 跟进 / 待办」；②@ 的是当前用户；③「【你｜<姓名>】」开头的行即本人自报。无法确定归属时，放进「需重点关注」并标注负责人，不要默认算成当前用户的。**绝不要输出「按你在群内的身份 XXX 整理」这类话**——身份由系统固定给出，无需你判断或声明。
【截止时间判定】以消息正文里**明确写出的时间表述**为准（如「周五前」「8/10 截止」）；**不要依赖消息创建时间戳**，也不要因时间戳异常而拒绝判断——缺失明确时间时标注「无明确截止时间」即可。
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

// 把用户输入（可能是纯文本，也可能是多模态内容数组）压成一段纯文本，用于意图识别。
function toPlainText(userInput) {
  if (typeof userInput === 'string') return userInput;
  if (Array.isArray(userInput)) {
    return userInput
      .map((p) => (p && p.type === 'text' ? p.text : ''))
      .join(' ');
  }
  return '';
}

// 从用户语句里抽取城市名。很多模型（尤其是自定义代理模型）不会按 TOOL: 协议自行调用工具，
// 因此这里在服务端直接识别「天气/气温类意图 + 城市」，提前把真实数据取回并注入上下文。
// 做法：先剥离时间词、疑问词、天气类关键词与常见口语前缀，剩下的 2~10 字地理片段即城市。
const CITY_STOP = /(今天|明天|后天|大后天|昨天|前天|周[一二三四五六日天]|星期[一二三四五六日天]|这周|下周|本周|未来\d+天|接下来\d+天|什么|怎么|怎样|如何|为什么|会[不没]?|是否|有没有|是不是|吗|呢|啊|呀|吧|哦|额|帮我|请|请问|我想|我要|我要看|查一下|查查|查询|看看|看一下|告诉[我您]|能不能|可以吗|麻烦|的天气|天气|气温|温度|下雨|降雨|下雪|气象|气候|穿衣|出行|情况|怎么样|是多少|多少度|适不适合|适合|注意|预报|预报吗|有雨|有雪|热不热|冷不冷|湿度)/g;
function extractCity(text) {
  if (!text) return null;
  let s = text.replace(CITY_STOP, ' ');
  // 进一步去掉残留的口语前缀（这些不是地名）
  s = s.replace(/(我想知道|我想看|我想|我知道|知道|了解|了解下|话说|那个|那个叫|就是|关于|那个|这个)/g, ' ');
  const m = s.match(/[一-龥A-Za-z·]{2,10}/);
  if (!m) return null;
  // 去掉首尾语气/结构助词，避免把「东京的」当成城市
  return m[0].replace(/^[的了啊呀吧哦呢]+|[的了啊呀吧哦呢]+$/g, '').trim() || null;
}

// 实时信息意图的「服务端预取」：模型不肯/不会调用工具时，由服务端直接执行对应工具，
// 把真实数据注入上下文，模型基于数据作答即可。返回拼接后的观测文本（可空）。
async function preExecRealtimeTools(tools, userInput, context, history) {
  const text = toPlainText(userInput);
  if (!text) return '';
  const obs = [];

  // 1) 天气
  const w = tools.get('get_weather');
  if (w) {
    // 收集候选城市：优先当前轮提取到的，其次从历史消息里出现过的（支持「那明天会下雨吗」追问）。
    // extractCity 可能误提非城市片段，因此用地理编码是否解析成功来最终裁决。
    const candidates = [];
    const cur = extractCity(text);
    if (cur) candidates.push(cur);
    if (Array.isArray(history)) {
      for (const h of history) {
        const c = extractCity(typeof h.content === 'string' ? h.content : '');
        if (c) { candidates.push(c); break; }
      }
    }
    let days = 2;
    const dm = text.match(/(\d+)\s*天/);
    if (dm) days = Math.min(7, Math.max(1, Number(dm[1]) || 2));
    let resolved = false;
    let lastObs = '';
    for (const c of candidates) {
      try {
        lastObs = await w.run({ city: c, days }, context);
      } catch (e) {
        lastObs = `天气查询失败：${e.message}`;
      }
      // 地理编码命中即采用；否则尝试下一个候选（如历史里的城市）
      if (!/未找到城市/.test(lastObs)) {
        obs.push(lastObs);
        resolved = true;
        break;
      }
    }
    if (!resolved && lastObs) obs.push(lastObs);
  }

  // 2) 网页链接读取（用户发了链接）
  const wr = tools.get('web_read');
  if (wr) {
    const urlm = text.match(/https?:\/\/[^\s，。？！）)、]+/);
    if (urlm) {
      try {
        obs.push(await wr.run({ url: urlm[0] }, context));
      } catch (e) {
        obs.push(`网页读取失败：${e.message}`);
      }
    }
  }

  // 3) 联网搜索（新闻/股价/赛事/最新等实时意图）
  const ws = tools.get('web_search');
  if (ws && /新闻|搜索|搜一下|搜搜|查一下最新|最新(消息|情况|进展)|股价|股票|券商|赛事|排行榜|今日|今天|最近|发生了什么|热搜|热点/.test(text)) {
    const q = text.replace(/[？?。.，,！!；;]/g, ' ').replace(/\s+/g, ' ').trim();
    try {
      obs.push(await ws.run({ query: q, top: 5 }, context));
    } catch (e) {
      obs.push(`联网搜索失败：${e.message}`);
    }
  }

  return obs.join('\n\n');
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
  // maxSteps: 可选，覆盖 this.maxSteps，用于「需要更多工具调用轮次」的场景（自动化任务等）
  // context: 可选，运行时上下文（如 { openId, chatId }），会透传给工具 run(args, context)
  async run(userInput, { chat, history = [], systemPrompt, maxSteps, context = {} } = {}) {
    const sys = systemPrompt || this.systemPrompt;
    const stepLimit = Number.isFinite(maxSteps) && maxSteps > 0 ? Math.floor(maxSteps) : this.maxSteps;
    // 实时信息「服务端预取」：先尝试识别天气/联网/网页意图并直接取数，
    // 再注入上下文，确保即使模型不调用工具也能基于真实数据作答。
    const realtimeObs = await preExecRealtimeTools(this.tools, userInput, context, history);
    const messages = [
      { role: 'system', content: `${sys}\n\n可用工具:\n${this.toolListText()}` },
      ...(realtimeObs
        ? [
            {
              role: 'system',
              content:
                '【已为用户查询到的实时数据，请直接基于以下真实数据回答用户的问题，不要声称你无法查询；数据若已足够就直接作答】\n' +
                realtimeObs,
            },
          ]
        : []),
      ...history,
      { role: 'user', content: userInput },
    ];

    const transcript = [];
    for (let step = 0; step < stepLimit; step++) {
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
    return { answer: '(已达到最大步数，请简化任务或稍后重试)', transcript, steps: stepLimit, truncated: true };
  }
}
