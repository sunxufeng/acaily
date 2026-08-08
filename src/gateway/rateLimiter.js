// 令牌桶限流：按 open_id 维度，防止单用户高频打爆下游 Provider。
// 内存实现，适合单实例 PoC；多实例部署应换 Redis 令牌桶。

export class TokenBucket {
  constructor({ capacity = 20, refillPerSec = 2 } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.buckets = new Map(); // key -> { tokens, last }
  }

  _refill(b) {
    const now = Date.now();
    const elapsedSec = (now - b.last) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
    b.last = now;
  }

  // 取 n 个令牌；不足则抛错（限流触发）
  take(key, n = 1) {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, last: Date.now() };
      this.buckets.set(key, b);
    }
    this._refill(b);
    if (b.tokens < n) {
      throw new RateLimitError(key, b.tokens, n);
    }
    b.tokens -= n;
    return true;
  }

  // 仅查询剩余令牌（用于管理后台展示）
  remaining(key) {
    const b = this.buckets.get(key);
    if (!b) return this.capacity;
    this._refill(b);
    return Math.floor(b.tokens);
  }
}

export class RateLimitError extends Error {
  constructor(key, tokens, want) {
    super(`限流：open_id=${key} 令牌不足（剩余 ${tokens.toFixed(1)} < 需要 ${want}）`);
    this.name = 'RateLimitError';
    this.key = key;
    this.tokens = tokens;
    this.want = want;
  }
}
