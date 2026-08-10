import { BaseProvider } from './base.js';

// OpenAI 兼容协议（含 DeepSeek / 通义 / 自建 OpenAI 风格网关）
export class OpenAICompatibleProvider extends BaseProvider {
  constructor(cfg, { chatCompletionsPath } = {}) {
    super(cfg);
    // 透传给基类；空值/未传由 base._url 兜底为 /chat/completions
    this.chatCompletionsPath = chatCompletionsPath === undefined ? '' : chatCompletionsPath;
  }

  async chat(messages) {
    const mp = this._modelParams();
    const body = {
      model: this.cfg.model,
      messages,
      // 默认同步非流式（_request 已支持 SSE 解析，stream:true 也能解析）。
      // 这里必须显式传一个 boolean，否则某些上游只接收 stream:false 的请求体。
      stream: mp.stream === true,
    };
    // base._modelParams() 返回 camelCase 字段；OpenAI 兼容协议线缆是 snake_case
    if (mp.temperature !== undefined) body.temperature = mp.temperature;
    if (mp.maxTokens !== undefined) body.max_tokens = mp.maxTokens;
    if (mp.topP !== undefined) body.top_p = mp.topP;
    if (mp.topK !== undefined) body.top_k = mp.topK;
    if (mp.frequencyPenalty !== undefined) body.frequency_penalty = mp.frequencyPenalty;
    if (mp.presencePenalty !== undefined) body.presence_penalty = mp.presencePenalty;

    const data = await this._request(this.chatCompletionsPath, {
      headers: { authorization: `Bearer ${this.cfg.apiKey || ''}` },
      body,
    });

    const content = data?.choices?.[0]?.message?.content ?? '';
    const usage = data?.usage ?? {};
    return {
      content,
      usage: {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
      },
    };
  }
}
