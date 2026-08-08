export const PROVIDER_TYPES = ['openai', 'anthropic', 'ollama', 'custom'];

// 校验用户自配的模型配置。返回错误数组（空=通过）。
export function validateUserModelConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return ['config 必须是对象'];
  }
  if (!PROVIDER_TYPES.includes(cfg.provider)) {
    errors.push(`provider 必须是 ${PROVIDER_TYPES.join(' / ')} 之一`);
  }
  if (!cfg.baseUrl || !/^https?:\/\//.test(cfg.baseUrl)) {
    errors.push('baseUrl 必须是合法的 http(s) URL');
  }
  if (!cfg.model || typeof cfg.model !== 'string') {
    errors.push('model 必填');
  }
  // ollama 本地部署无需 API Key
  if (cfg.provider !== 'ollama' && !cfg.apiKey) {
    errors.push('非 ollama provider 必须提供 apiKey');
  }
  if (cfg.temperature !== undefined) {
    if (typeof cfg.temperature !== 'number' || cfg.temperature < 0 || cfg.temperature > 2) {
      errors.push('temperature 必须在 0..2 之间');
    }
  }
  if (cfg.maxTokens !== undefined) {
    if (!Number.isInteger(cfg.maxTokens) || cfg.maxTokens < 1) {
      errors.push('maxTokens 必须是正整数');
    }
  }
  return errors;
}
