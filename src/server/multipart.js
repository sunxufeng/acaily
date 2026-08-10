// 零依赖 multipart/form-data 解析 + 原始请求体读取。
// 用于 /api/upload 等需要接收文件上传的接口；保持主 app.js 精简。

export function readRawBody(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > maxBytes) {
        reject(new Error('payload too large (> ' + maxBytes + ' bytes)'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 解析 multipart/form-data，返回 [{ name, filename, contentType, data }]
export function parseMultipart(buf, boundary) {
  const sep = Buffer.from('--' + boundary);
  const parts = [];
  let pos = 0;
  while (pos < buf.length) {
    const start = buf.indexOf(sep, pos);
    if (start < 0) break;
    pos = start + sep.length;
    if (pos + 1 < buf.length && buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break;
    if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) pos += 2;
    const next = buf.indexOf(sep, pos);
    if (next < 0) break;
    const section = buf.subarray(pos, next);
    const hdEnd = section.indexOf('\r\n\r\n');
    if (hdEnd < 0) continue;
    const headStr = section.subarray(0, hdEnd).toString('utf8');
    let name = '', filename = '', contentType = '';
    const cd = headStr.match(/Content-Disposition:\s*form-data;([^\r\n]+)/i);
    if (cd) {
      const nm = cd[1].match(/name="([^"]*)"/);
      if (nm) name = nm[1];
      const fn = cd[1].match(/filename="([^"]*)"/);
      if (fn) filename = fn[1];
    }
    const ct = headStr.match(/Content-Type:\s*([^\r\n]+)/i);
    if (ct) contentType = ct[1].trim();
    let data = section.subarray(hdEnd + 4);
    if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
      data = data.subarray(0, data.length - 2);
    }
    parts.push({ name, filename, contentType, data });
    pos = next;
  }
  return parts;
}