// 可插拔向量存储（T4.2）：内存实现 + 统一接口，生产可换 pgvector/Milvus/Qdrant。
import { cosineSimilarity } from './embeddings.js';

export class MemoryVectorStore {
  constructor() { this.items = []; } // { id, docId, text, vector, meta }
  async upsert(docId, chunks, vectors, meta = {}) {
    const ids = [];
    for (let i = 0; i < chunks.length; i++) {
      const id = `${docId}#${i}`;
      this.items.push({ id, docId, text: chunks[i], vector: vectors[i], meta });
      ids.push(id);
    }
    return ids;
  }
  // 向量检索 topK + 关键词命中加权（混合召回）
  async search(queryVector, queryText, { topK = 5, keywordBoost = 0.15 } = {}) {
    const qTokens = new Set(String(queryText || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
    const scored = this.items.map((it) => {
      let score = cosineSimilarity(queryVector, it.vector);
      if (qTokens.size) {
        const hit = (it.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((t) => qTokens.has(t)).length;
        score += Math.min(hit, 5) * keywordBoost;
      }
      return { ...it, score };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }
  async deleteByDoc(docId) { this.items = this.items.filter((i) => i.docId !== docId); }
}
