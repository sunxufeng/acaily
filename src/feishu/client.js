// 飞书开放平台客户端：获取 tenant_access_token 并发送文本消息。
// 仅在配置了 FEISHU_APP_ID / FEISHU_APP_SECRET 时可用（PoC 可直接跑，回复发送会被跳过）。

const FEISHU_HOST = 'https://open.feishu.cn';

let _tokenCache = { token: null, expAt: 0 };

export async function getTenantToken() {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) return null;

  const now = Date.now();
  if (_tokenCache.token && now < _tokenCache.expAt) return _tokenCache.token;

  const res = await fetch(`${FEISHU_HOST}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`获取 tenant_access_token 失败: ${data.msg}`);
  _tokenCache = { token: data.tenant_access_token, expAt: now + (data.expire - 60) * 1000 };
  return _tokenCache.token;
}

// 以机器人身份给指定 open_id 发送文本消息（receive_id_type=open_id）
export async function sendText(openId, text) {
  const token = await getTenantToken();
  if (!token) return { skipped: true, reason: '未配置飞书凭据' };

  const res = await fetch(`${FEISHU_HOST}/open-apis/im/v1/messages?receive_id_type=open_id`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: openId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`发送飞书消息失败: ${data.msg}`);
  return { ok: true, messageId: data.data?.message_id };
}

// 下载飞书消息里的图片（image_key），转成 data URL 交给多模态模型。
// 飞书图片下载接口直接返回图片二进制（Content-Type=image/*），用 tenant token 鉴权。
const IMG_MAX_BYTES = 8 * 1024 * 1024; // 8MB 上限，超过拒绝（避免巨型 base64 撑爆请求/上下文）
export async function downloadImage(imageKey) {
  const token = await getTenantToken();
  if (!token) return null;
  const res = await fetch(`${FEISHU_HOST}/open-apis/im/v1/images/${imageKey}?type=message`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`下载飞书图片失败 HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > IMG_MAX_BYTES) {
    throw new Error(`图片过大（约 ${Math.round(buf.length / 1024)}KB），上限 8MB，请发送更小的截图`);
  }
  const ct = res.headers.get('content-type') || 'image/png';
  const mime = ct.startsWith('image/') ? ct : 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// 把 Markdown 渲染成飞书互动卡片（卡片内 markdown 元素可正常渲染排版）
// 超过卡片上限或发送失败时，回退为纯文本（剥离 markdown 语法）
const CARD_MD_LIMIT = 4000;

export function stripMarkdown(md = '') {
  return md
    .replace(/```[\s\S]*?```/g, (m) => '\n' + m.replace(/```/g, '').trim() + '\n')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/#{1,6}\s?/g, '')
    .replace(/^>\s?/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*\d+\.\s+/gm, '• ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 飞书互动卡片的 markdown 元素**不支持 # 标题语法**（会原样显示成 ## 字面字符），
// 也**不支持 > 块引用语法**（会原样显示成 > 字面字符）。
// 处理：标题行转加粗；块引用行转斜体（连续多行合并为一段），保证卡片里不再出现裸 # / >。
export function cardMarkdown(md = '') {
  const lines = (md || '').split('\n');
  const out = [];
  let quoteBuf = null;
  const flushQuote = () => {
    if (quoteBuf === null) return;
    const t = quoteBuf.join(' ').trim();
    quoteBuf = null;
    if (t) out.push(`*${t}*`); // 飞书卡片支持 *斜体*
  };
  for (const line of lines) {
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) {
      if (quoteBuf === null) quoteBuf = [];
      quoteBuf.push(q[1].trim());
      continue;
    }
    flushQuote();
    const m = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (!m) {
      out.push(line);
      continue;
    }
    const level = m[1].length;
    const text = m[2].trim();
    // 一/二级标题用加粗，三级及以下加粗 + 前缀，避免与正文混在一起
    if (level <= 2) out.push(`**${text}**`);
    else out.push(`· **${text}**`);
  }
  flushQuote();
  return out.join('\n');
}

export async function sendMarkdown(openId, md) {
  const token = await getTenantToken();
  if (!token) return { skipped: true, reason: '未配置飞书凭据' };

  let content = (md || '').trim();
  // 超长：直接回退纯文本，避免卡片超限
  if (content.length > CARD_MD_LIMIT) {
    return sendText(openId, stripMarkdown(content));
  }

  // 卡片 markdown 不支持 # 标题，先转成加粗
  const cardContent = cardMarkdown(content);

  const card = {
    config: { streaming_mode: false },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'Acaily' },
    },
    elements: [{ tag: 'markdown', content: cardContent }],
  };

  const res = await fetch(`${FEISHU_HOST}/open-apis/im/v1/messages?receive_id_type=open_id`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: openId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    // 卡片失败（权限/格式）→ 回退纯文本
    console.warn('[feishu] 卡片发送失败，回退文本:', data.msg);
    return sendText(openId, stripMarkdown(content));
  }
  return { ok: true, messageId: data.data?.message_id, card: true };
}
