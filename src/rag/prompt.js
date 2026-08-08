// RAG 提示词组装（T4.3）：系统约束 + 带引用的上下文 + 防幻觉约束。
export function buildRagPrompt(query, context, { history = [] } = {}) {
  const system = [
    '你是 Acaily 的知识库问答助手。',
    '仅使用下面「知识库内容」中的信息作答；若内容不足以回答，明确告知用户「知识库中未找到相关信息」，不要编造。',
    '回答时在每个事实后标注引用，如 [1]、[2]；引用编号对应知识库内容前的【[n] 来源】标记。',
    '保持简洁、准确，使用中文。',
  ].join('\n');

  const kbBlock = `【知识库内容】\n${context || '(无)'}`;
  const histBlock = history.length
    ? '\n【对话历史】\n' + history.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n')
    : '';

  const user = `${kbBlock}${histBlock}\n\n【问题】${query}\n\n请基于上述知识库内容回答：`;
  return { system, user };
}

// 把模型回答与引用来源整理为可展示结构（供前端/日志溯源）
export function formatAnswer(answer, results) {
  return {
    answer,
    citations: results.map((r) => ({ index: r.index, source: r.citation, snippet: r.text.slice(0, 120) })),
  };
}
