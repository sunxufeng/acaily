import { getConfig, decryptApiKey } from '../config/userConfigStore.js';
import { getProvider, ProviderError } from '../providers/index.js';
import { TokenBucket, RateLimitError } from './rateLimiter.js';
import { track } from '../admin/stats.js';

const limiter = new TokenBucket({
  capacity: Number(process.env.ACAILY_RATE_CAPACITY || 20),
  refillPerSec: Number(process.env.ACAILY_RATE_REFILL || 2),
});

const DEFAULT_MAX_RETRIES = Number(process.env.ACAILY_MAX_RETRIES || 2);

function backoffMs(attempt) {
  return 200 * 2 ** (attempt - 1); // 200, 400, 800...
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 按 open_id 路由到用户自配模型：解析配置 → 信封解密 Key → 选适配器 → 限流 → 重试 → 降级
export async function routeChat(openId, messages, opts = {}) {
  const cfg = getConfig(openId);
  if (!cfg) {
    throw new ProviderError(
      '该飞书用户尚未配置模型（请在个人设置页配置 Provider / API Key / Model）',
      { provider: 'gateway', status: 404 }
    );
  }
  const apiKey = decryptApiKey(openId); // ollama 为 null
  return doRoute({ cfg, apiKey, openId, displayName: cfg.displayName || '', messages, opts });
}

// 以显式配置（而非 open_id 查找）路由：供「智能体」等场景复用同一套限流/重试/统计逻辑。
// cfg 需含 { provider, model, baseUrl, displayName, retries? }；apiKey 为明文（已解密）。
export async function routeChatConfig(cfg, apiKey, messages, opts = {}) {
  if (!cfg || !cfg.provider) {
    throw new ProviderError('智能体未配置模型（请在智能体配置页填写 Provider / API Key / Model）', {
      provider: 'gateway',
      status: 404,
    });
  }
  const displayName = cfg.displayName || cfg.name || '智能体';
  const openId = `agent:${cfg.id || 'unknown'}`; // 仅用于统计标识
  return doRoute({ cfg, apiKey, openId, displayName, messages, opts });
}

// 核心路由：限流 → 选适配器 → 重试 → 降级 → 统计
async function doRoute({ cfg, apiKey, openId, displayName, messages, opts = {} }) {
  // 限流（令牌桶）
  try {
    limiter.take(openId, 1);
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    throw err;
  }

  // 用户配置字段名为 provider，适配器注册表按 type 索引，这里做一次映射
  // opts.model：调用方可临时覆盖本次请求的模型（如浏览器插件切换模型 / 智能体指定模型）
  const provider = getProvider({
    ...cfg,
    type: cfg.provider,
    apiKey,
    model: opts.model || cfg.model,
  });

  // 单用户可单独配置重试次数；缺失则走系统默认（环境变量或 2）
  const maxRetries = Number.isInteger(cfg.retries) ? cfg.retries : DEFAULT_MAX_RETRIES;

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) await sleep(backoffMs(attempt));
      const res = await provider.chat(messages);
      // 单点统计：所有成功 chat 调用都会被记录，无论来自 /chat、/agent/chat 还是自动化 runner
      try {
        await track({
          openId,
          name: displayName,
          provider: cfg.provider,
          model: cfg.model,
          promptTokens: res.usage?.promptTokens || 0,
          completionTokens: res.usage?.completionTokens || 0,
        });
      } catch { /* 统计失败不影响主流程 */ }
      return {
        content: res.content,
        usage: res.usage,
        provider: cfg.provider,
        model: cfg.model,
        userName: displayName,
        attempt: attempt + 1,
      };
    } catch (err) {
      lastErr = err;
      // 4xx 客户端错误（非 429）属于配置/鉴权问题，不重试
      if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) break;
    }
  }

  // 降级：返回友好提示而非硬失败（生产可降级到小模型或兜底话术）
  const fallback = process.env.ACAILY_DEGRADE_MESSAGE;
  if (fallback) {
    return { content: fallback, degraded: true, error: lastErr?.message, provider: cfg.provider };
  }
  throw lastErr ?? new ProviderError('模型调用失败', { provider: 'gateway' });
}

// 连通性测试：配置保存前/后一键验证
export async function testConnection(openId, inlineCfg) {
  let cfg = getConfig(openId);
  if (inlineCfg && inlineCfg.provider) {
    const storedApiKey = decryptApiKey(openId);
    cfg = { ...(cfg || {}), ...inlineCfg };
    if (!cfg.apiKey && storedApiKey) cfg.apiKey = storedApiKey;
  }
  if (!cfg || !cfg.provider) return { ok: false, error: '未配置模型（请先保存或填写配置）' };
  const apiKey = cfg.apiKey || decryptApiKey(openId);
  const provider = getProvider({ ...cfg, type: cfg.provider, apiKey });
  try {
    await provider.test();
    return { ok: true, provider: cfg.provider, model: cfg.model };
  } catch (err) {
    return { ok: false, error: err.message, attemptedUrl: err.attemptedUrl, provider: cfg.provider };
  }
}

export function rateLimitRemaining(openId) {
  return limiter.remaining(openId);
}
