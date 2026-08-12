// 所有 Provider 适配器的基类：统一的 chat 接口、超时控制、错误包装。
// 内部消息格式：{ role: 'system' | 'user' | 'assistant', content: string }

// 默认总超时。观澜等慢模型单次回复常需 50s+，故给到 90s 余量；
// 真正的「挂起」上游会在 90s 内被 readBodyToString 中止并转为超时错误，而非无限挂起。
const DEFAULT_TIMEOUT_MS = 90_000;

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
  constructor(message, { status, provider, cause, retryable } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.provider = provider;
    this.cause = cause;
    // retryable=false 时，调用方（如路由层的重试循环）应放弃重试，避免把一次慢/挂起请求放大成 N 倍等待
    this.retryable = retryable;
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

  // 统一请求封装：超时 + JSON + SSE 流式 + 错误包装
  // 当上游返回 text/event-stream（SSE）时，自动按 data: {...} 增量解析，
  // 累积 delta.content 为完整 content，并在最后一个 chunk 里读 usage。
  // 这样不论用户提供 stream=true 还是 false，OpenAI 兼容 / Claude 兼容协议都能 work。
  async _request(path, { method = 'POST', headers = {}, body, timeoutMs } = {}) {
    const url = this._url(path);
    const ms = timeoutMs || (Number(this.cfg.timeout) > 0 ? Number(this.cfg.timeout) * 1000 : DEFAULT_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    // 合并请求头：自定义头 < 自定义调用方头 < API Key 类头
    const userHeaders = (this.cfg.customHeaders && typeof this.cfg.customHeaders === 'object')
      ? { ...this.cfg.customHeaders }
      : {};
    try {
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json', ...userHeaders, ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const ctype = res.headers.get('content-type') || '';
      // 统一「带总超时」读取响应体：Node undici 在响应头已返回后，不会因 AbortController
      // 中断「响应体」读取，慢/挂起的上游会让 res.text() 永久挂起 → 调用方永远拿不到结果。
      // 因此这里改用带截止时间的 reader 读取，超时即中止。
      const raw = await readBodyToString(res, ms, controller);
      if (res.ok && /text\/event-stream/i.test(ctype)) {
        return parseSseString(raw, url, this.type);
      }
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch { /* 非 JSON 响应 */ }
      if (!res.ok) {
        const detail = data && (data.error?.message || data.error || raw);
        const hint = errorHint(res.status, detail || raw);
        throw new ProviderError(
          `${this.type} 请求失败 (${res.status}): ${detail || res.statusText}${hint ? '\n' + hint : ''}`,
          { status: res.status, provider: this.type, attemptedUrl: url }
        );
      }
      return data;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err.name === 'AbortError') {
        // 超时/中止属于「上游太慢或挂起」，重试几乎必然再次超时，徒增等待，故标记不可重试。
        throw new ProviderError(`${this.type} 请求超时（>${ms}ms）`, { provider: this.type, cause: err, retryable: false });
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
    const num = (k, v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
    const t = num('temperature', this.cfg.temperature);
    if (t !== undefined && !Number.isNaN(t)) p.temperature = t;
    const mx = num('maxTokens', this.cfg.maxTokens);
    if (mx !== undefined && !Number.isNaN(mx)) p.maxTokens = mx;
    const tp = num('topP', this.cfg.topP);
    if (tp !== undefined && !Number.isNaN(tp)) p.topP = tp;
    const tk = num('topK', this.cfg.topK);
    if (tk !== undefined && !Number.isNaN(tk)) p.topK = tk;
    const fp = num('frequencyPenalty', this.cfg.frequencyPenalty);
    if (fp !== undefined && !Number.isNaN(fp)) p.frequencyPenalty = fp;
    const pp = num('presencePenalty', this.cfg.presencePenalty);
    if (pp !== undefined && !Number.isNaN(pp)) p.presencePenalty = pp;
    // 流式：默认同步非流式（更兼容各种 OpenAI 兼容上游；用户显式 true 才走 SSE）
    if (this.cfg.stream === true) p.stream = true;
    return p;
  }
}

// 解析 OpenAI 兼容协议的 Server-Sent Events（SSE）响应：
// 把每行 `data: {...}` 视作增量，choices[0].delta.content 累加成完整回复；
// usage 通常在最后一个 chunk（choices:[] + usage 非空）出现，结束标记为 `data: [DONE]`。
// 返回结构与普通 JSON 一致：{ choices:[{message:{role,content}}], usage }，
// 这样所有 provider（openai/anthropic/custom/acplugin）透明复用，不再被「流式返回空内容」卡死。
// 带截止时间的响应体读取：Node undici 在「响应头已返回」后不会因 AbortController 中断
// 「响应体」读取，慢/挂起的上游会让 res.text() 永久挂起。这里用 reader + 截止时间竞速，
// 超过 ms 仍读不到下一块就主动 abort 并抛 AbortError（交由 _request 转成超时错误）。
async function readBodyToString(res, ms, controller) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8');
  const deadline = (typeof ms === 'number' && ms > 0) ? Date.now() + ms : 0;
  let buf = '';
  while (true) {
    let chunk;
    if (deadline) {
      const remain = deadline - Date.now();
      if (remain <= 0) {
        if (controller && controller.abort) try { controller.abort(); } catch { /* ignore */ }
        throw Object.assign(new Error('响应体读取超时'), { name: 'AbortError' });
      }
      chunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => {
          if (controller && controller.abort) try { controller.abort(); } catch { /* ignore */ }
          reject(Object.assign(new Error('响应体读取超时'), { name: 'AbortError' }));
        }, remain)),
      ]);
    } else {
      chunk = await reader.read();
    }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
  }
  buf += decoder.decode();
  return buf;
}

// 解析 OpenAI 兼容协议的 Server-Sent Events（SSE）文本（已完整读取到 raw 字符串）：
// 把每行 `data: {...}` 视作增量，choices[0].delta.content 累加成完整回复；
// usage 通常在最后一个 chunk 出现，结束标记为 `data: [DONE]`。
// 返回结构与普通 JSON 一致：{ choices:[{message:{role,content}}], usage }。
export function parseSseString(raw, _url, _type) {
  let full = '';
  let lastUsage = null;
  let finishReason = null;
  let role = 'assistant';
  for (const evt of raw.split('\n\n')) {
    let dataLine = null;
    for (const line of evt.split('\n')) {
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { dataLine = '[DONE]'; break; }
        if (dataLine == null) dataLine = payload;
      }
    }
    if (dataLine == null || dataLine === '[DONE]') continue;
    try {
      const obj = JSON.parse(dataLine);
      const ch0 = obj.choices && obj.choices[0];
      if (ch0) {
        const delta = ch0.delta || {};
        if (delta.role) role = delta.role;
        if (delta.content) full += delta.content;
        if (ch0.finish_reason) finishReason = ch0.finish_reason;
      }
      if (obj.usage && (obj.usage.prompt_tokens != null || obj.usage.completion_tokens != null)) {
        lastUsage = obj.usage;
      }
    } catch {
      // 跳过非 JSON 行（部分代理会插入心跳 / 注释）
    }
  }
  return {
    choices: [{ message: { role, content: full }, finish_reason: finishReason || 'stop' }],
    usage: lastUsage || {},
  };
}
