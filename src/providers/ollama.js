import { BaseProvider } from './base.js';

// Ollama 本地部署协议（无需 API Key）
export class OllamaProvider extends BaseProvider {
  async chat(messages) {
    const mp = this._modelParams();
    const options = {};
    if (mp.temperature !== undefined) options.temperature = mp.temperature;
    if (mp.maxTokens !== undefined) options.num_predict = mp.maxTokens;
    if (mp.topP !== undefined) options.top_p = mp.topP;
    if (mp.topK !== undefined) options.top_k = mp.topK;
    // Ollama 把频率/重复惩罚合二为一：repeat_penalty ∈ [0, 2]；map 频率惩罚到同一字段
    if (mp.frequencyPenalty !== undefined) options.repeat_penalty = Math.max(0, 1 + mp.frequencyPenalty * 0.5);
    if (mp.presencePenalty !== undefined) options.repeat_last_n = Math.max(0, Math.round(Math.abs(mp.presencePenalty) * 32));

    const body = {
      model: this.cfg.model,
      messages,
      stream: mp.stream === true,
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
