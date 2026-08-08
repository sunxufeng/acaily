import { OpenAICompatibleProvider } from './openai.js';

// 自建网关：默认按 OpenAI 兼容协议，但 chat/completions 路径可配置（cfg.chatCompletionsPath）
export class CustomProvider extends OpenAICompatibleProvider {
  constructor(cfg) {
    const path = cfg.chatCompletionsPath || '/chat/completions';
    super(cfg, { chatCompletionsPath: path });
  }
}
