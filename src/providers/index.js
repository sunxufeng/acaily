import { OpenAICompatibleProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { OllamaProvider } from './ollama.js';
import { CustomProvider } from './custom.js';
import { YuanBaoProvider } from './yuanbao.js';
import { ProviderError } from './base.js';

// Provider 注册表：type -> 适配器工厂
const REGISTRY = {
  openai: (cfg) => new OpenAICompatibleProvider(cfg),
  anthropic: (cfg) => new AnthropicProvider(cfg),
  ollama: (cfg) => new OllamaProvider(cfg),
  custom: (cfg) => new CustomProvider(cfg),
  yuanbao: (cfg) => new YuanBaoProvider(cfg),
};

export function getProvider(cfg) {
  const factory = REGISTRY[cfg.type];
  if (!factory) {
    throw new ProviderError(`不支持的 provider 类型: ${cfg.type}`, { provider: cfg.type });
  }
  return factory(cfg);
}

export { ProviderError };
