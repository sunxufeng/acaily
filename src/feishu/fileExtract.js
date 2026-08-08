// 零依赖文件内容提取：把飞书消息里的文件（Word / Excel / PPT / PDF / 文本 / Markdown 等）
// 转成纯文本，交给模型做摘要、问答或结构化整理。
//
// 设计原则：
// - 不引入任何 npm 依赖（Office 文档本质是 ZIP，用 node:zlib 解压 + XML 文本抽取；
//   文本类文件直接解码；PDF 做尽力而为的流式文本抽取）。
// - 所有失败都可降级：抽不出来就返回 null，由调用方给出友好提示，而不是把垃圾喂给模型。

import { inflateRawSync } from 'node:zlib';

const TEXT_EXTS = new Set([
  '.txt', '.text', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl',
  '.log', '.yaml', '.yml', '.xml', '.html', '.htm',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.go', '.rs', '.kt',
  '.sh', '.bash', '.zsh', '.sql', '.ini', '.cfg', '.conf', '.toml',
]);

// 飞书云文档（在线文档）通过 im/v1/files 下载不到二进制，需要走 docs API；
// 这类 file_type 单独标记，由调用方提示用户导出后发送。
export const CLOUD_DOC_TYPES = new Set([
  'doc', 'sheet', 'bitable', 'mindnote', 'slides', 'wiki', 'folder',
]);

const EXTRACTABLE_TYPES = new Set(['docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm', 'pdf']);

function extOf(fileName = '') {
  const i = fileName.lastIndexOf('.');
  return i >= 0 ? fileName.slice(i).toLowerCase() : '';
}

// ---------- 通用：文本解码（UTF-8 优先，含替换符则回退 GBK） ----------
export function decodeTextBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf8', 3);
  }
  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/�/g) || []).length;
  if (bad > 0 && bad > utf8.length / 200) {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      /* 忽略，回退 utf8 */
    }
  }
  return utf8;
}

// ---------- 极小 ZIP 读取器（仅支持 deflate=8 / store=0，覆盖 Office 文档） ----------
function unzip(buffer) {
  const files = new Map();
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('非有效 ZIP');
  const cdOffset = dv.getUint32(eocd + 16, true);
  const cdCount = dv.getUint16(eocd + 10, true);
  let p = cdOffset;
  for (let n = 0; n < cdCount; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buffer.subarray(dataStart, dataStart + compSize);
    let out;
    if (method === 0) out = Buffer.from(data);
    else if (method === 8) out = inflateRawSync(data);
    else out = null;
    if (out) files.set(name, out);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ---------- XML 实体解码 ----------
function decodeXml(s = '') {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&'); // 放最后，避免把已解码实体再次破坏
}

// ---------- DOCX ----------
function extractDocx(buffer) {
  const files = unzip(buffer);
  const doc = files.get('word/document.xml');
  if (!doc) return '';
  // 先把结构标签换成分隔符，再剥掉其余所有标签，最后解码实体。
  // 注意：不能用 <w:t...> 正则直接抓文本——<w:tblPr> 等标签也会命中 <w:t 前缀。
  let s = doc
    .toString('utf8')
    .replace(/<w:br\s*\/?>/g, '\n')
    .replace(/<w:tab\s*\/?>/g, '\t')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeXml(s);
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- XLSX ----------
function parseSharedStrings(buf) {
  const xml = buf.toString('utf8');
  const out = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let sm;
  while ((sm = siRe.exec(xml))) {
    const ti = sm[1].match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
    out.push(ti.map((x) => decodeXml((x.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '')).join(''));
  }
  return out;
}

function extractXlsx(buffer) {
  const files = unzip(buffer);
  const ssRaw = files.get('xl/sharedStrings.xml');
  const shared = ssRaw ? parseSharedStrings(ssRaw) : [];
  const sheets = [...files.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => {
      const na = parseInt(a.match(/sheet(\d+)/)[1], 10);
      const nb = parseInt(b.match(/sheet(\d+)/)[1], 10);
      return na - nb;
    });
  const rows = [];
  for (const sf of sheets) {
    const xml = files.get(sf).toString('utf8');
    const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml))) {
      const cells = [];
      const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let cm;
      while ((cm = cRe.exec(rm[1]))) {
        const attrs = cm[1] || '';
        const tMatch = attrs.match(/\bt="([^"]*)"/);
        const t = tMatch ? tMatch[1] : '';
        const inner = cm[2] || '';
        let val = '';
        if (t === 's') {
          const idx = (inner.match(/<v>(\d+)<\/v>/) || [])[1];
          val = idx != null ? shared[Number(idx)] || '' : '';
        } else if (t === 'inlineStr' || t === 'str') {
          const ti = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
          val = ti ? decodeXml(ti[1]) : '';
        } else {
          const v = inner.match(/<v>([\s\S]*?)<\/v>/);
          val = v ? v[1] : '';
        }
        cells.push(val);
      }
      rows.push(cells.join('\t'));
    }
  }
  return rows.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- PPTX ----------
function extractPptx(buffer) {
  const files = unzip(buffer);
  const slides = [...files.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => parseInt(a.match(/slide(\d+)/)[1], 10) - parseInt(b.match(/slide(\d+)/)[1], 10));
  const parts = [];
  for (const sf of slides) {
    const xml = files.get(sf).toString('utf8').replace(/<[^>]+>/g, ' ');
    parts.push(decodeXml(xml).replace(/\s+/g, ' ').trim());
  }
  return parts.filter(Boolean).join('\n\n').trim();
}

// ---------- PDF（尽力而为：解压流 + 抽取 Tj/TJ 文本算子） ----------
function decodePdfString(raw) {
  // raw: 可能是普通字符串（latin1）或已解码字节数组
  let bytes;
  if (typeof raw === 'string') bytes = Buffer.from(raw, 'latin1');
  else bytes = Buffer.from(raw);
  // UTF-16BE BOM
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    try {
      return bytes.toString('utf16le', 2);
    } catch {
      /* fallthrough */
    }
  }
  // 反斜杠转义
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x5c) {
      // '\'
      const n = bytes[i + 1];
      if (n === 0x6e) { s += '\n'; i++; }
      else if (n === 0x72) { s += '\r'; i++; }
      else if (n === 0x74) { s += '\t'; i++; }
      else if (n === 0x62) { s += '\b'; i++; }
      else if (n === 0x66) { s += '\f'; i++; }
      else if (n === 0x28 || n === 0x29 || n === 0x5c) { s += String.fromCharCode(n); i++; }
      else if (n >= 0x30 && n <= 0x37) {
        // 八进制 \ddd
        let oct = '';
        let j = 0;
        while (j < 3 && i + 1 + j < bytes.length && bytes[i + 1 + j] >= 0x30 && bytes[i + 1 + j] <= 0x37) {
          oct += String.fromCharCode(bytes[i + 1 + j]);
          j++;
        }
        s += String.fromCharCode(parseInt(oct, 8) & 0xff);
        i += j;
      } else {
        s += String.fromCharCode(b);
      }
    } else {
      // PDFDocEncoding：高位字节按 Latin-1 近似（CJK 无 ToUnicode 时不可靠，属已知限制）
      s += String.fromCharCode(b);
    }
  }
  return s;
}

function pdfStringsFromContent(content) {
  const s = content.toString('latin1');
  const res = [];
  const re = /\((?:\\.|[^()\\])*\)\s*Tj|\[(?:\s*(?:\((?:\\.|[^()\\])*\)|<[0-9A-Fa-f\s]*>)\s*-?\d*\.?\d*\s*)*\]\s*TJ/g;
  let m;
  while ((m = re.exec(s))) {
    const block = m[0];
    const strRe = /\(((?:\\.|[^()\\])*)\)|<([0-9A-Fa-f\s]+)>/g;
    let sm;
    while ((sm = strRe.exec(block))) {
      if (sm[1] != null) res.push(decodePdfString(sm[1]));
      else if (sm[2] != null && sm[2].trim()) {
        const clean = sm[2].replace(/\s+/g, '');
        const arr = [];
        for (let i = 0; i + 1 < clean.length; i += 2) arr.push(parseInt(clean.substr(i, 2), 16));
        res.push(decodePdfString(Buffer.from(arr)));
      }
    }
  }
  return res;
}

function extractPdf(buffer) {
  const latin = buffer.toString('latin1');
  const out = [];
  const streamRe = /stream\s*?[\r\n]+([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = streamRe.exec(latin))) {
    const before = latin.slice(Math.max(0, m.index - 300), m.index);
    const isFlate = /FlateDecode/i.test(before);
    const raw = Buffer.from(m[1], 'latin1');
    let content;
    if (isFlate) {
      try {
        content = inflateRawSync(raw);
      } catch {
        content = raw;
      }
    } else {
      content = raw;
    }
    out.push(...pdfStringsFromContent(content));
  }
  const text = out.join(' ').replace(/\s+/g, ' ').trim();
  return text;
}

// ---------- 对外入口 ----------
// 返回 { text, truncated, lowYield }；不支持或失败返回 { text: '', unsupported: true }
export function extractText(buffer, fileName = '', mime = '') {
  const ext = extOf(fileName);
  const lowerMime = (mime || '').toLowerCase();

  // 纯文本类
  if (TEXT_EXTS.has(ext) || lowerMime.startsWith('text/') || lowerMime === 'application/json') {
    return { text: decodeTextBuffer(buffer), truncated: false, lowYield: false };
  }

  // Office / PDF
  try {
    if (ext === '.docx' || ext === '.docm') {
      return { text: extractDocx(buffer), truncated: false, lowYield: false };
    }
    if (ext === '.xlsx' || ext === '.xlsm') {
      return { text: extractXlsx(buffer), truncated: false, lowYield: false };
    }
    if (ext === '.pptx' || ext === '.pptm') {
      return { text: extractPptx(buffer), truncated: false, lowYield: false };
    }
    if (ext === '.pdf' || lowerMime === 'application/pdf') {
      const text = extractPdf(buffer);
      // 仅在「文件较大却几乎抽不出文字」时判定为低质量（多为扫描件/特殊编码）；
      // 短小但正常的 PDF 不应被判为失败。
      const lowYield = text.length < 30 && buffer.length > 20 * 1024;
      return { text, truncated: false, lowYield };
    }
  } catch (e) {
    return { text: '', unsupported: true, reason: `文档解析失败：${e.message}` };
  }

  // PDF 仅靠 mime 但无扩展名的情况已在上面覆盖；其余视为不支持
  return { text: '', unsupported: true };
}

// 统一截断（避免超大文档撑爆模型上下文）
export function truncateExtracted(text, maxChars = 40000) {
  if (!text || text.length <= maxChars) return { text: text || '', truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}
