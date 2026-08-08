// 飞书长连接（WebSocket）事件订阅客户端
// 与 Webhook 模式二选一：本文件实现「长连接」接收方式。
// 无需公网回调地址；SDK 内置鉴权、心跳保活与断线重连。
// 复用 app.js 的 processFeishuMessage(openId, text) 作为统一消息处理入口。
import { WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';

let started = false;
let wsInstance = null;

export function startFeishuConnection(onMessage) {
  if (started) return;
  started = true;

  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    console.warn('[feishu-ws] 未配置 FEISHU_APP_ID / FEISHU_APP_SECRET，长连接不启动（Webhook 模式仍可用）。');
    return;
  }

  const ws = new WSClient({
    appId,
    appSecret,
    autoReconnect: true,
    onReconnected: () => console.log('[feishu-ws] 连接已恢复（重连成功）。'),
    onError: (err) => {
      const msg = (err && err.message) ? err.message : String(err);
      console.error('[feishu-ws] 连接错误:', msg);
      // 飞书后台未将接收方式切换为「长连接」时，建连会被拒绝。
      if (/long.?connect|persistent|eventbus|not enabled|未开启|receive.*mode/i.test(msg)) {
        console.error('[feishu-ws] 提示：请在飞书开放平台将该应用的「事件订阅 → 接收方式」改为「长连接（WebSocket）」，并订阅 im.message.receive_v1。');
      }
    },
  });

  const dispatcher = new EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      try {
        const ev = data && data.event ? data.event : data;
        const sender = ev && ev.sender;
        const msg = ev && ev.message;
        if (!sender || !msg) {
          console.log(
            '[feishu-ws] 收到事件但缺 sender/message 字段: header=' +
              (data && data.header && data.header.event_type) || '?'
          );
          return;
        }
        const senderOpenId = sender.sender_id && sender.sender_id.open_id;
        const chatType = msg.chat_type; // 'p2p' | 'group'
        const messageType = msg.message_type;

        // 群聊里只响应 @本机器人 的消息（mentions 非空）
        if (chatType === 'group' && (!msg.mentions || msg.mentions.length === 0)) {
          console.log(`[feishu-ws] 群消息未 @机器人，跳过 chat_id=${msg.chat_id}`);
          return;
        }

        const text =
          messageType === 'text'
            ? (() => {
                try {
                  return JSON.parse(msg.content || '{}').text || '';
                } catch {
                  return '';
                }
              })()
            : '';

        console.log(
          `[feishu-ws] 收到消息 chat=${chatType} type=${messageType} openId=${senderOpenId} textLen=${text.length}`
        );

        if (senderOpenId && text && text.trim()) {
          await onMessage(senderOpenId, text.trim());
        } else if (senderOpenId && !text) {
          console.log(
            `[feishu-ws] 收到非文本或空文本 type=${messageType}，等待下一次文本消息`
          );
        }
      } catch (e) {
        console.error('[feishu-ws] 处理事件失败:', e.message, e.stack);
      }
    },
  });

  try {
    wsInstance = ws;
    ws.start({ eventDispatcher: dispatcher });
    console.log('[feishu-ws] 长连接客户端已启动，等待飞书推送事件。');
  } catch (e) {
    console.error('[feishu-ws] 启动失败:', e.message);
  }
}

// 供 /health 等接口查询长连接状态
export function getFeishuWsStatus() {
  if (!started) return { started: false };
  let status = 'unknown';
  try { status = wsInstance ? wsInstance.getConnectionStatus() : 'unknown'; } catch {}
  return { started: true, status };
}
