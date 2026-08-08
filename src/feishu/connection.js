// 飞书长连接（WebSocket）事件订阅客户端
// 与 Webhook 模式二选一：本文件实现「长连接」接收方式。
// 无需公网回调地址；SDK 内置鉴权、心跳保活与断线重连。
// 复用 app.js 的 processFeishuMessage(openId, text) 作为统一消息处理入口。
//
// 关键设计：
// 1. handler 同步快速返回 → SDK 立刻 ack → 飞书不重发（避免一次对话被处理 N 次）
// 2. 内存去重 (openId, messageId) 60s 窗口，兜底网络抖动/飞书重试
// 3. 真正业务处理 setImmediate 推到下一 tick，不阻塞 ack
import { WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { downloadImage } from './client.js';

let started = false;
let wsInstance = null;

// 内存去重：60 秒内同 (openId, messageId) 只处理一次
const _seen = new Map(); // key -> expiresAt(ms)
const DEDUP_TTL_MS = 60_000;
function isDuplicate(openId, messageId) {
  const key = `${openId}::${messageId}`;
  const now = Date.now();
  // 顺便清理过期
  if (_seen.size > 256) {
    for (const [k, t] of _seen) if (t < now) _seen.delete(k);
  }
  if (_seen.has(key) && _seen.get(key) > now) return true;
  _seen.set(key, now + DEDUP_TTL_MS);
  return false;
}

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
      if (/long.?connect|persistent|eventbus|not enabled|未开启|receive.*mode/i.test(msg)) {
        console.error('[feishu-ws] 提示：请在飞书开放平台将该应用的「事件订阅 → 接收方式」改为「长连接（WebSocket）」，并订阅 im.message.receive_v1。');
      }
    },
  });

  // ⚠️ handler 必须是「同步函数」：一旦 await onMessage(...)，SDK 会在 promise
  // resolve 之后才 ack；如果 LLM+工具+回复超过飞书 3 秒窗口，飞书会判定「未 ack」
  // 并自动重发同一事件，导致一条用户消息被处理 2~3 次、回复多条。
  // 正确做法：handler 同步立即 return，async 业务用 setImmediate 推到下一 tick。
  const dispatcher = new EventDispatcher({}).register({
    'im.message.receive_v1': (data) => {
      try {
        const ev = data && data.event ? data.event : data;
        const sender = ev && ev.sender;
        const msg = ev && ev.message;
        if (!sender || !msg) {
          console.log(
            '[feishu-ws] 收到事件但缺 sender/message 字段: header=' +
              ((data && data.header && data.header.event_type) || '?')
          );
          return;
        }
        const senderOpenId = sender.sender_id && sender.sender_id.open_id;
        const messageId = msg.message_id;
        const chatType = msg.chat_type; // 'p2p' | 'group'
        const messageType = msg.message_type;

        if (!senderOpenId || !messageId) {
          console.log('[feishu-ws] 缺 openId/messageId，跳过');
          return;
        }

        // 群聊里只响应 @本机器人 的消息
        if (chatType === 'group' && (!msg.mentions || msg.mentions.length === 0)) {
          console.log(`[feishu-ws] 群消息未 @机器人，跳过 chat_id=${msg.chat_id}`);
          return;
        }

        // 内存去重：飞书重发/网络抖动时同一事件只处理一次
        if (isDuplicate(senderOpenId, messageId)) {
          console.log(
            `[feishu-ws] 重复事件去重 openId=${senderOpenId} mid=${messageId}（飞书重试或网络抖动，忽略）`
          );
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

        // 图片消息：从 content 提取 image_key（飞书 image 类型 content = {"image_key":"..."}）
        let imageKey = null;
        if (messageType === 'image') {
          try {
            imageKey = JSON.parse(msg.content || '{}').image_key || null;
          } catch {
            imageKey = null;
          }
        }

        console.log(
          `[feishu-ws] 收到消息 chat=${chatType} type=${messageType} openId=${senderOpenId} textLen=${text.length} img=${imageKey ? 'yes' : 'no'} mid=${messageId}`
        );

        if (text && text.trim()) {
          // 业务处理推到下一 tick，handler 同步 return → SDK 立即 ack
          setImmediate(() => {
            Promise.resolve()
              .then(() => onMessage(senderOpenId, text.trim()))
              .catch((e) => console.error('[feishu-ws] onMessage 失败:', e.message, e.stack));
          });
        } else if (imageKey) {
          // 图片消息：先下载图片（异步），再交给统一入口；下载失败则仍以纯文本兜底
          setImmediate(() => {
            Promise.resolve()
              .then(async () => {
                let image = null;
                try {
                  image = await downloadImage(imageKey);
                } catch (e) {
                  console.error('[feishu-ws] 下载图片失败:', e.message);
                }
                return onMessage(senderOpenId, '', image);
              })
              .catch((e) => console.error('[feishu-ws] onMessage(图片) 失败:', e.message, e.stack));
          });
        } else {
          console.log(
            `[feishu-ws] 收到未支持的消息类型 type=${messageType}，跳过`
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
