// 嵌入接口（T4.1）：可插拔。默认提供本地确定性嵌入（仅用于单测/演示），
// 生产替换为 OpenAI/通义 embedding API 实现相同 embed() 接口即可。
const DIM = 256;

function hashToken(t) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

// 基于词袋的确定性伪向量（局部敏感，便于单测验证相似度排序）
export function localEmbed(text) {
  const vec = new Array(DIM).fill(0);
  const tokens = String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  for (const tk of tokens) {
    const h = hashToken(tk);
    vec[h % DIM] += 1;
    vec[(h >> 8) % DIM] += 0.5;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

export class EmbeddingService {
  constructor(provider = localEmbed) { this.provider = provider; }
  async embed(text) { return this.provider(text); }
  // 批量嵌入（真实 provider 可并发/批处理）
  async embedBatch(texts) { return Promise.all(texts.map((t) => this.embed(t))); }
}

export const cosineSimilarity = (a, b) => {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // a,b 已归一化，点积即余弦
};
