export const PROVIDER_TYPES = ['openai', 'anthropic', 'ollama', 'custom', 'acplugin'];

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
  // 个人模型配置名（仅展示）
  if (cfg.configName !== undefined && cfg.configName !== '') {
    if (typeof cfg.configName !== 'string' || cfg.configName.length > 60) {
      errors.push('configName 必须是 60 字以内的字符串');
    }
  }
  // 模型列表（多行，每行一个；首项同步进 cfg.model，避免改动网关调用的兼容性）
  if (cfg.models !== undefined) {
    if (!Array.isArray(cfg.models)) {
      errors.push('models 必须是字符串数组');
    } else if (cfg.models.some((m) => typeof m !== 'string' || !m.trim())) {
      errors.push('models 每项必须是非空字符串');
    } else if (cfg.models.length > 32) {
      errors.push('models 最多 32 个');
    }
  }
  // 采样参数：Top P（核采样）
  if (cfg.topP !== undefined && cfg.topP !== '') {
    const v = Number(cfg.topP);
    if (Number.isNaN(v) || v < 0 || v > 1) errors.push('topP 必须在 0..1 之间');
  }
  // 高级采样：Top K（仅部分模型支持）
  if (cfg.topK !== undefined && cfg.topK !== '') {
    const v = Number(cfg.topK);
    if (!Number.isInteger(v) || v < 1) errors.push('topK 必须是正整数');
  }
  // 频率/重复惩罚：-2..2
  if (cfg.frequencyPenalty !== undefined && cfg.frequencyPenalty !== '') {
    const v = Number(cfg.frequencyPenalty);
    if (Number.isNaN(v) || v < -2 || v > 2) errors.push('frequencyPenalty 必须在 -2..2 之间');
  }
  if (cfg.presencePenalty !== undefined && cfg.presencePenalty !== '') {
    const v = Number(cfg.presencePenalty);
    if (Number.isNaN(v) || v < -2 || v > 2) errors.push('presencePenalty 必须在 -2..2 之间');
  }
  // 能力与输出：布尔开关
  if (cfg.stream !== undefined && cfg.stream !== null && typeof cfg.stream !== 'boolean') {
    errors.push('stream 必须是布尔值');
  }
  if (cfg.multimodal !== undefined && cfg.multimodal !== null && typeof cfg.multimodal !== 'boolean') {
    errors.push('multimodal 必须是布尔值');
  }
  // 请求控制
  if (cfg.timeout !== undefined && cfg.timeout !== '') {
    const v = Number(cfg.timeout);
    if (!Number.isInteger(v) || v < 1 || v > 600) errors.push('timeout 必须在 1..600 秒之间');
  }
  if (cfg.retries !== undefined && cfg.retries !== '') {
    const v = Number(cfg.retries);
    if (!Number.isInteger(v) || v < 0 || v > 5) errors.push('retries 必须在 0..5 之间');
  }
  // 自定义请求头：必须是 plain object（键字符串，值非空字符串）
  if (cfg.customHeaders !== undefined && cfg.customHeaders !== null) {
    if (typeof cfg.customHeaders !== 'object' || Array.isArray(cfg.customHeaders)) {
      errors.push('customHeaders 必须是对象');
    } else if (
      Object.entries(cfg.customHeaders).some(
        ([k, v]) => !/^[A-Za-z0-9-]+$/.test(k) || typeof v !== 'string' || !v
      )
    ) {
      errors.push('customHeaders 键名仅允许字母数字与 -，值必须是非空字符串');
    }
  }
  return errors;
}
