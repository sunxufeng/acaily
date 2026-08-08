export const PROVIDER_TYPES = ['openai', 'anthropic', 'ollama', 'custom'];

// 校验用户自配的模型配置。返回错误数组（空=通过）。
// requireApiKey=false 时不强制要求 apiKey（用于「更新配置但留空密钥=沿用已存密钥」的场景）。
export function validateUserModelConfig(cfg, { requireApiKey = true } = {}) {
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
  // ollama 本地部署无需 API Key；或调用方声明「沿用已存密钥」时也不强制
  if (requireApiKey && cfg.provider !== 'ollama' && !cfg.apiKey) {
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
  if (cfg.chatCompletionsPath !== undefined && cfg.chatCompletionsPath !== '') {
    if (typeof cfg.chatCompletionsPath !== 'string' || !/^\//.test(cfg.chatCompletionsPath)) {
      errors.push('chatCompletionsPath 必须以 / 开头');
    }
  }
  // 个人助手人设（非必填，宽松校验长度）
  if (cfg.botName !== undefined && cfg.botName !== '') {
    if (typeof cfg.botName !== 'string' || cfg.botName.length > 40) {
      errors.push('botName 必须是 40 字以内的字符串');
    }
  }
  if (cfg.systemPrompt !== undefined && cfg.systemPrompt !== '') {
    if (typeof cfg.systemPrompt !== 'string' || cfg.systemPrompt.length > 4000) {
      errors.push('systemPrompt 必须是 4000 字以内的字符串');
    }
  }
  if (cfg.displayName !== undefined && cfg.displayName !== '') {
    if (typeof cfg.displayName !== 'string' || cfg.displayName.length > 60) {
      errors.push('displayName 必须是 60 字以内的字符串');
    }
  }
  return errors;
}
