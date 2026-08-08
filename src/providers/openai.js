import { BaseProvider } from './base.js';

// OpenAI 兼容协议（含 DeepSeek / 通义 / 自建 OpenAI 风格网关）
export class OpenAICompatibleProvider extends BaseProvider {
  constructor(cfg, { chatCompletionsPath } = {}) {
    super(cfg);
    // 透传给基类；空值/未传由 base._url 兜底为 /chat/completions
    this.chatCompletionsPath = chatCompletionsPath === undefined ? '' : chatCompletionsPath;
  }

  async chat(messages) {
    const body = {
      model: this.cfg.model,
      messages,
      stream: false,
      ...this._modelParams(),
    };
    if (this.cfg.maxTokens !== undefined) body.max_tokens = this.cfg.maxTokens;

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
