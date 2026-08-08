import { BaseProvider } from './base.js';

// Ollama 本地部署协议（无需 API Key）
export class OllamaProvider extends BaseProvider {
  async chat(messages) {
    const options = {};
    if (this.cfg.temperature !== undefined) options.temperature = this.cfg.temperature;
    if (this.cfg.maxTokens !== undefined) options.num_predict = this.cfg.maxTokens;

    const body = {
      model: this.cfg.model,
      messages,
      stream: false,
      options,
    };

    const data = await this._request('/api/chat', { body });
    const content = data?.message?.content ?? '';
    return {
      content,
      usage: {
        promptTokens: data?.prompt_eval_count ?? 0,
        completionTokens: data?.eval_count ?? 0,
      },
    };
  }
}
