// 用量与成本统计（T5.1）：按用户/Provider 聚合对话调用与 token 消耗。
const counters = { byOpenId: {}, byProvider: {}, total: 0, tokens: 0 };

export function track({ openId, provider, tokens = 0 }) {
  counters.total += 1;
  counters.tokens += tokens;
  counters.byOpenId[openId] = (counters.byOpenId[openId] || 0) + 1;
  counters.byProvider[provider] = (counters.byProvider[provider] || 0) + 1;
}

export function snapshot() {
  return {
    totalCalls: counters.total,
    totalTokens: counters.tokens,
    byOpenId: { ...counters.byOpenId },
    byProvider: { ...counters.byProvider },
  };
}

export function reset() {
  counters.byOpenId = {}; counters.byProvider = {}; counters.total = 0; counters.tokens = 0;
}
