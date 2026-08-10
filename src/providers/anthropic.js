import { BaseProvider } from './base.js';

// Anthropic Messages 协议（Claude）
export class AnthropicProvider extends BaseProvider {
  async chat(messages) {
    // Anthropic 把 system 单独传，messages 只含 user/assistant
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const conv = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));

    const mp = this._modelParams();
    const body = {
      model: this.cfg.model,
      messages: conv,
      stream: mp.stream === true,
    };
    if (system) body.system = system;
    // Anthropic 仅支持 temperature / top_p / top_k；其余字段忽略
    if (mp.temperature !== undefined) body.temperature = mp.temperature;
    if (mp.maxTokens !== undefined) body.max_tokens = mp.maxTokens;
    if (mp.topP !== undefined) body.top_p = mp.topP;
    if (mp.topK !== undefined) body.top_k = mp.topK;

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
