// 所有 Provider 适配器的基类：统一的 chat 接口、超时控制、错误包装。
// 内部消息格式：{ role: 'system' | 'user' | 'assistant', content: string }

const DEFAULT_TIMEOUT_MS = 30_000;

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
        throw new ProviderError(
          `${this.type} 请求失败 (${res.status}): ${detail || res.statusText}`,
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
    // 路径为空表示 baseUrl 已是完整接口地址，直接使用（避免重复拼接）
    if (!path) return base;
    return base + path;
  }

  _modelParams() {
    const p = {};
    if (this.cfg.temperature !== undefined) p.temperature = this.cfg.temperature;
    if (this.cfg.maxTokens !== undefined) p.maxTokens = this.cfg.maxTokens;
    return p;
  }
}
