// 文档分块（T4.1）：按段落优先、超长按字符窗口滑动切分。
export function chunkText(text, { maxChars = 800, overlap = 80 } = {}) {
  const paragraphs = String(text || '').split(/\n{1,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = '';
  const flush = () => { if (buf.trim()) chunks.push(buf.trim()); buf = ''; };

  for (const p of paragraphs) {
    if (p.length <= maxChars) {
      if ((buf + '\n' + p).length > maxChars) { flush(); buf = p; }
      else buf = buf ? buf + '\n' + p : p;
    } else {
      flush();
      // 超长段落按窗口滑动
      for (let i = 0; i < p.length; i += maxChars - overlap) {
        chunks.push(p.slice(i, i + maxChars).trim());
      }
    }
  }
  flush();
  return chunks;
}
