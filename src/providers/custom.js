import { OpenAICompatibleProvider } from './openai.js';

// 自建网关：默认按 OpenAI 兼容协议，但 chat/completions 路径可配置（cfg.chatCompletionsPath）
export class CustomProvider extends OpenAICompatibleProvider {
  constructor(cfg) {
    // 留空 → 把 baseUrl 当作完整接口地址直接使用（用户常把整条 URL 填进 Base URL）
    const path = cfg.chatCompletionsPath || '';
    super(cfg, { chatCompletionsPath: path });
  }
}
