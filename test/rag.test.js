import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../src/rag/chunker.js';
import { EmbeddingService, localEmbed, cosineSimilarity } from '../src/rag/embeddings.js';
import { MemoryVectorStore } from '../src/rag/vectorStore.js';
import { Retriever } from '../src/rag/retriever.js';
import { buildRagPrompt, formatAnswer } from '../src/rag/prompt.js';

test('chunkText: 按段落切分，超长段落滑动', () => {
  const long = 'x'.repeat(2000);
  const chunks = chunkText(`段落一\n\n段落二\n\n${long}`);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.length <= 2000));
});

test('embeddings: 相似文本余弦相似度高于不相关文本', async () => {
  const a = localEmbed('飞书 模型 网关 路由');
  const b = localEmbed('飞书 模型 网关 配置');
  const c = localEmbed('今天天气 晴朗 适合 散步');
  assert.ok(cosineSimilarity(a, b) > cosineSimilarity(a, c));
});

test('vectorStore + retriever: 检索返回相关块并带引用', async () => {
  const embed = new EmbeddingService();
  const store = new MemoryVectorStore();
  const r = new Retriever(embed, store);
  await r.ingest('doc1', 'Acaily 的模型网关按飞书 open_id 路由到用户自配的 Provider。', { source: '设计文档' });
  await r.ingest('doc2', '上海今天下雨，气温 18 度。', { source: '天气' });
  const res = await r.retrieve('模型网关如何路由', { topK: 1 });
  assert.equal(res[0].docId, 'doc1');
  assert.equal(res[0].index, 1);
  assert.ok(res[0].citation.includes('设计文档'));
});

test('retriever.buildContext: 拼接带引用标记', async () => {
  const r = new Retriever(new EmbeddingService(), new MemoryVectorStore());
  await r.ingest('d', 'KMS 信封加密保护 API Key。', { source: '安全' });
  const res = await r.retrieve('KMS 是什么');
  const ctx = r.buildContext(res);
  assert.ok(ctx.includes('【[1] 安全】'));
});

test('buildRagPrompt: 包含知识库与防幻觉约束', () => {
  const { system, user } = buildRagPrompt('什么是信封加密', '【[1] 安全】\nKMS 信封加密。');
  assert.ok(system.includes('不要编造'));
  assert.ok(user.includes('知识库内容'));
  assert.ok(user.includes('什么是信封加密'));
});

test('formatAnswer: 整理引用来源', () => {
  const out = formatAnswer('答案', [{ index: 1, citation: '[1] 安全', text: 'KMS 信封加密保护 API Key。' }]);
  assert.equal(out.citations[0].source, '[1] 安全');
});
