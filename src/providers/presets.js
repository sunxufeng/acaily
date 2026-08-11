// 「市面上常用大模型」预置清单：每个预设给出一个常见默认 Base URL，
// 选完后可一键复用，剩余 key / 模型 / 路径仍由用户手填。
// 协议分类：
//   - openai  → OpenAI 兼容协议（绝大多数国产/海外厂商都走这套）
//   - anthropic → Anthropic Messages 协议
//   - ollama  → 本地 Ollama
//   - custom  → 用户手填完整接口（兜底）
//
// 这些 type 直接对应 src/providers/index.js 里的注册键（'openai'、'anthropic'、'ollama'、'custom'），
// 含义保持 OpenAI 协议兼容；具体厂商只通过 defaultBaseUrl 区分。

export const PROVIDER_PRESETS = [
  {
    type: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    sampleModels: 'gpt-4o-mini\ngpt-4o\no1-mini\no3-mini',
    hint: 'OpenAI 官方',
  },
  {
    type: 'openai',
    label: 'DeepSeek（深度求索）',
    defaultBaseUrl: 'https://api.deepseek.com',
    sampleModels: 'deepseek-chat\ndeepseek-reasoner',
    hint: 'OpenAI 兼容协议',
  },
  {
    type: 'openai',
    label: '通义千问 Qwen（DashScope 兼容模式）',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    sampleModels: 'qwen-plus\nqwen-turbo\nqwen-max',
    hint: '阿里云百炼，OpenAI 兼容端点',
  },
  {
    type: 'openai',
    label: '月之暗面 Kimi',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    sampleModels: 'moonshot-v1-8k\nmoonshot-v1-32k\nmoonshot-v1-128k',
    hint: 'Moonshot AI，OpenAI 兼容',
  },
  {
    type: 'openai',
    label: '智谱 GLM（BigModel）',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    sampleModels: 'glm-4-plus\nglm-4-flash\nglm-4-air',
    hint: '智谱开放平台，OpenAI 兼容端点',
  },
  {
    type: 'openai',
    label: '字节豆包 Doubao（火山方舟 Ark）',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    sampleModels: 'doubao-pro-32k\ndoubao-lite-32k\ndoubao-1-5-pro-32k-250115',
    hint: '火山引擎方舟，OpenAI 兼容',
  },
  {
    type: 'openai',
    label: '百度千帆（文心一言）',
    defaultBaseUrl: 'https://qianfan.baidubce.com/v2',
    sampleModels: 'ernie-4.0-8k\nernie-3.5-8k\nernie-speed-8k',
    hint: '百度智能云千帆，OpenAI 兼容 v2 端点',
  },
  {
    type: 'openai',
    label: 'MiniMax（Anthropic 兼容）',
    defaultBaseUrl: 'https://api.minimax.com/anthropic',
    sampleModels: 'MiniMax-Text-01\nMiniMax-VL-01',
    hint: '?',
  },
  {
    type: 'anthropic',
    label: 'Anthropic Claude（官方）',
    defaultBaseUrl: 'https://api.anthropic.com',
    sampleModels: 'claude-3-5-sonnet-latest\nclaude-3-5-haiku-latest\nclaude-3-opus-latest',
    hint: 'Anthropic Messages 协议',
  },
  {
    type: 'ollama',
    label: 'Ollama（本地）',
    defaultBaseUrl: 'http://localhost:11434',
    sampleModels: 'llama3.1\nqwen2.5\ndeepseek-r1',
    hint: '本地推理，无需 API Key',
  },
  {
    type: 'custom',
    label: '自定义（自建网关 / 其它）',
    defaultBaseUrl: '',
    sampleModels: '',
    hint: 'OpenAI 兼容协议；按 Base URL + 路径访问',
  },
];

// 按 label 查预设
export function findPresetByLabel(label) {
  return PROVIDER_PRESETS.find((p) => p.label === label) || null;
}

// 按 (type, baseUrl) 找一个最匹配的预设为默认显示
export function matchPreset(type, baseUrl) {
  if (!type) return null;
  // 先按 type 严格匹配；再选 baseUrl 完全相同或最相近的一条
  const sameType = PROVIDER_PRESETS.filter((p) => p.type === type);
  if (!sameType.length) return null;
  if (baseUrl) {
    const exact = sameType.find((p) => p.defaultBaseUrl === baseUrl);
    if (exact) return exact;
  }
  return sameType[0];
}
