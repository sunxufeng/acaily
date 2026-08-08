import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket, RateLimitError } from '../src/gateway/rateLimiter.js';

test('容量内可正常取令牌', () => {
  const b = new TokenBucket({ capacity: 3, refillPerSec: 0 });
  assert.equal(b.take('k', 1), true);
  assert.equal(b.take('k', 1), true);
  assert.equal(b.take('k', 1), true);
  assert.equal(b.remaining('k'), 0);
});

test('超出容量抛 RateLimitError', () => {
  const b = new TokenBucket({ capacity: 2, refillPerSec: 0 });
  b.take('k', 2);
  assert.throws(() => b.take('k', 1), RateLimitError);
});

test('不同 key 独立限流', () => {
  const b = new TokenBucket({ capacity: 1, refillPerSec: 0 });
  b.take('a', 1);
  assert.equal(b.take('b', 1), true); // 不同用户互不影响
});

test('补充速率会让令牌回升', async () => {
  const b = new TokenBucket({ capacity: 1, refillPerSec: 10 }); // 10/s = 0.01/ms
  b.take('k', 1);
  assert.equal(b.remaining('k'), 0);
  await new Promise((r) => setTimeout(r, 120)); // ~1.2 令牌补充
  assert.equal(b.take('k', 1), true);
});
