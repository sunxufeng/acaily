import { createHmac, timingSafeEqual } from 'node:crypto';

// 飞书事件订阅回调处理：
//   1) url_verification（首次配置回调 URL 的 challenge 校验）
//   2) 事件签名校验（X-Lark-Signature = HMAC-SHA256(timestamp + nonce + body, app_secret) 的 hex）
//   3) 解析 im.message.receive_v1，抽取 sender.open_id 与文本消息

export function verifySignature({ timestamp, nonce, body, signature }, appSecret) {
  if (!signature || !appSecret) return false;
  const raw = `${timestamp}${nonce}${body}`;
  const expected = createHmac('sha256', appSecret).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

// 解析原始 body（字符串或已解析对象），返回结构化事件
export function parseEvent(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (data.type === 'url_verification') {
    return { type: 'url_verification', challenge: data.challenge };
  }
  return {
    type: 'event_callback',
    eventType: data.header?.event_type,
    eventId: data.header?.event_id,
    event: data.event,
  };
}

// 从 im.message.receive_v1 事件抽取 { openId, text, messageId, chatType }
export function extractMessage(parsed) {
  if (parsed.eventType !== 'im.message.receive_v1') return null;
  const evt = parsed.event;
  const sender = evt?.sender;
  const message = evt?.message;
  if (!sender?.sender_id?.open_id || !message) return null;

  let text = '';
  try {
    const content = JSON.parse(message.content || '{}');
    text = content.text || '';
  } catch {
    text = '';
  }
  // 把 @_user_1 这类 mention 占位符替换成真实姓名（飞书 content.text 用占位符表示 @人）
  if (text && message.mentions && message.mentions.length) {
    for (const m of message.mentions) {
      if (m && m.key) text = text.split(m.key).join(m.name || m.key);
    }
    text = text.trim();
  }
  return {
    openId: sender.sender_id.open_id,
    // union_id 在同一开发商旗下的不同飞书应用间稳定一致，是「跨应用发消息」的关键：
    // 自动化用观澜(子应用)身份推送时，接收方 open_id 是主应用维度的，直接发会报
    // "open_id cross app"，必须改用 union_id 才能让观澜应用正确寻址到同一用户。
    unionId: sender.sender_id?.union_id || null,
    userId: sender.sender_id?.user_id || null,
    text,
    messageId: message.message_id,
    chatType: message.chat_type, // p2p / group
    chatId: message.chat_id, // 用于把「当前会话」传给飞书会话读取工具
  };
}
