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
        const msg = ev && ev.message;
        if (!msg) {
          console.log('[feishu-ws] 收到事件但无 message 字段:', (data && data.header && data.header.event_type) || '?');
          return;
        }
        const openId = msg.sender && msg.sender.sender_id && msg.sender.sender_id.open_id;
        const text = msg.message_type === 'text'
          ? (() => { try { return JSON.parse(msg.content || '{}').text || ''; } catch { return ''; } })()
          : '';
        console.log(`[feishu-ws] 收到消息 event_type=${msg.message_type} openId=${openId} textLen=${text.length}`);
        if (openId && text) await onMessage(openId, text.trim());
      } catch (e) {
        console.error('[feishu-ws] 处理事件失败:', e.message);
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
