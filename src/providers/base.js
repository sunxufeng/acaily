// 所有 Provider 适配器的基类：统一的 chat 接口、超时控制、错误包装。
// 内部消息格式：{ role: 'system' | 'user' | 'assistant', content: string }

const DEFAULT_TIMEOUT_MS = 30_000;

// 把底层 HTTP / 网络错误包装成用户能看懂的提示（移植自 acplugin ProviderManager.formatProviderError）
function errorHint(status, raw) {
  const s = (raw || '').toString();
  if (status === 401 || /Unauthorized|invalid_api_key|Incorrect API key|authentication/i.test(s)) {
    return '请检查 API Key 是否正确，或该 Key 是否拥有调用此模型的权限。';
  }
  if (status === 404 || /Not Found/i.test(s)) {
    return '请检查 Base URL 与模型 ID 是否匹配。';
  }
  if (status === 429 || /Too Many Requests|rate limit/i.test(s)) {
    return '请求过于频繁或额度不足，请稍后重试。';
  }
  if (status >= 500) {
    return '服务端暂时不可用，请稍后重试。';
  }
  if (/CORS|cross-origin|blocked by/i.test(s)) {
    return '请求被拦截。请确认 Base URL 支持跨域，或改用 HTTPS 端点。';
  }
  if (/ECONNREFUSED|ETIMEDOUT|fetch failed|ENOTFOUND|network/i.test(s)) {
    return '网络不可达，请检查网络与代理设置。';
  }
  return '';
}

export class ProviderError extends Error {
  constructor(message, { status, provider, cause } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.provider = provider;
    this.cause = cause;
  }
}

export class BaseProvider {
  // cfg: { type, baseUrl, apiKey, model, temperature, maxTokens }
  constructor(cfg) {
    this.cfg = cfg;
    this.type = cfg.type;
  }

  // 子类实现：返回 { content, usage:{promptTokens, completionTokens} }
  async chat(/* messages */) {
    throw new ProviderError('chat() 未实现', { provider: this.type });
  }

  // 连通性测试：发一个最小请求，能跑通即返回 true；失败抛 ProviderError
  async test() {
    const res = await this.chat([
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'pong' },
      { role: 'user', content: '请只回复 OK' },
    ]);
    return typeof res.content === 'string' && res.content.length > 0;
  }

  // 统一请求封装：超时 + JSON + 错误包装
  async _request(path, { method = 'POST', headers = {}, body } = {}) {
    const url = this._url(path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
      if (!res.ok) {
        const detail = data && (data.error?.message || data.error || text);
        const hint = errorHint(res.status, detail || text);
        throw new ProviderError(
          `${this.type} 请求失败 (${res.status}): ${detail || res.statusText}${hint ? '\n' + hint : ''}`,
          { status: res.status, provider: this.type, attemptedUrl: url }
        );
      }
      return data;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err.name === 'AbortError') {
        throw new ProviderError(`${this.type} 请求超时（>${DEFAULT_TIMEOUT_MS}ms）`, { provider: this.type, cause: err });
      }
      throw new ProviderError(`${this.type} 网络错误: ${err.message}`, { provider: this.type, cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  _url(path) {
    const base = String(this.cfg.baseUrl).replace(/\/$/, '');
    // 默认补 /chat/completions；允许显式覆盖（如 /openai/v1/chat/completions）
    const p = (path && String(path).trim()) ? String(path).trim() : '/chat/completions';
    // 避免 baseUrl 已含该路径时重复拼接（如用户把整条地址填进 Base URL）
    if (base.endsWith(p)) return base;
    return base + p;
  }

  _modelParams() {
    const p = {};
    if (this.cfg.temperature !== undefined) p.temperature = this.cfg.temperature;
    if (this.cfg.maxTokens !== undefined) p.maxTokens = this.cfg.maxTokens;
    return p;
  }
}
