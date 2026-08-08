// 检索器（T4.2）：编排 分块→嵌入→入库→查询，产出带引用的上下文。
import { chunkText } from './chunker.js';
import { MemoryVectorStore } from './vectorStore.js';

export class Retriever {
  constructor(embed, store = new MemoryVectorStore()) {
    this.embed = embed;
    this.store = store;
  }
  async ingest(docId, text, meta = {}) {
    const chunks = chunkText(text);
    const vectors = await this.embed.embedBatch(chunks);
    return this.store.upsert(docId, chunks, vectors, meta);
  }
  async retrieve(query, { topK = 5 } = {}) {
    const qVec = await this.embed.embed(query);
    const hits = await this.store.search(qVec, query, { topK });
    // 编号引用 [1..n]，供提示词与答案溯源
    return hits.map((h, i) => ({
      index: i + 1,
      docId: h.docId,
      text: h.text,
      score: Number(h.score.toFixed(4)),
      citation: `[${i + 1}] ${h.meta.source || h.docId}`,
    }));
  }
  // 拼接可注入模型提示词的上下文字符串
  buildContext(results) {
    if (!results.length) return '(无相关知识库内容)';
    return results.map((r) => `【${r.citation}】\n${r.text}`).join('\n\n');
  }
}
