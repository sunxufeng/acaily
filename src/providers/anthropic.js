import { BaseProvider } from './base.js';

// Anthropic Messages 协议（Claude）
export class AnthropicProvider extends BaseProvider {
  async chat(messages) {
    // Anthropic 把 system 单独传，messages 只含 user/assistant
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const conv = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));

    const body = {
      model: this.cfg.model,
      messages: conv,
      stream: false,
      ...this._modelParams(),
    };
    if (system) body.system = system;
    if (this.cfg.maxTokens !== undefined) body.max_tokens = this.cfg.maxTokens;

    const data = await this._request('/v1/messages', {
      headers: {
        'x-api-key': this.cfg.apiKey || '',
        'anthropic-version': '2023-06-01',
      },
      body,
    });

    const content = (data?.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const usage = data?.usage ?? {};
    return {
      content,
      usage: {
        promptTokens: usage.input_tokens ?? 0,
        completionTokens: usage.output_tokens ?? 0,
      },
    };
  }
}
