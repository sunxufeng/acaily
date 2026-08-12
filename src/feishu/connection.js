// 飞书长连接（WebSocket）事件订阅客户端
// 与 Webhook 模式二选一：本文件实现「长连接」接收方式。
// 无需公网回调地址；SDK 内置鉴权、心跳保活与断线重连。
// 复用 app.js 的 processFeishuMessage(openId, text, ...) 作为统一消息处理入口。
//
// 多应用路由：主应用（环境变量凭据）与「每个绑定了飞书应用的智能体」各自建立一条
// 独立的 WS 长连接。事件天然按 app_id 归类，因此收到消息时即可知道归属哪个智能体，
// 进而以该智能体的人设 + 模型回复，并用该应用自身的 tenant_access_token 发送。
//
// 关键设计：
// 1. handler 同步快速返回 → SDK 立刻 ack → 飞书不重发（避免一次对话被处理 N 次）
// 2. 内存去重 (openId, messageId) 60s 窗口，兜底网络抖动/飞书重试
// 3. 真正业务处理 setImmediate 推到下一 tick，不阻塞 ack

import { WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { downloadImage, downloadFile } from './client.js';
import { extractText, truncateExtracted, CLOUD_DOC_TYPES } from './fileExtract.js';
import { listBoundAgents } from '../config/agentStore.js';
import { setUnionId } from '../config/userConfigStore.js';

// 把消息里 @_user_1 这类占位符替换成真实姓名，避免模型收到裸占位符而困惑。
function resolveMentions(text, mentions) {
  if (!text || !mentions || !mentions.length) return text;
  let out = text;
  for (const m of mentions) {
    if (m && m.key) out = out.split(m.key).join(m.name || m.key);
  }
  return out.trim();
}

// 内存去重：60 秒内同 (openId, messageId) 只处理一次
const _seen = new Map(); // key -> expiresAt(ms)
const DEDUP_TTL_MS = 60_000;
function isDuplicate(openId, messageId) {
  const key = `${openId}::${messageId}`;
  const now = Date.now();
  if (_seen.size > 512) {
    for (const [k, t] of _seen) if (t < now) _seen.delete(k);
  }
  if (_seen.has(key) && _seen.get(key) > now) return true;
  _seen.set(key, now + DEDUP_TTL_MS);
  return false;
}

const _instances = new Map(); // label -> ws instance

// 构造一个「消息事件分发器」：把 im.message.receive_v1 解析后交给 onMessage。
// creds：该应用的 { appId, appSecret }（主应用为 null → 使用环境变量）；
//       用于下载图片/文件以及后续回复时选用正确的飞书身份。
// agentId：归属的智能体 id（主应用为 null）。
function makeDispatcher({ creds, label, agentId, onMessage }) {
  return new EventDispatcher({}).register({
    'im.message.receive_v1': (data) => {
      try {
        const ev = data && data.event ? data.event : data;
        const sender = ev && ev.sender;
        const msg = ev && ev.message;
        if (!sender || !msg) {
          console.log(
            `[feishu-ws:${label}] 收到事件但缺 sender/message 字段: header=` +
              ((data && data.header && data.header.event_type) || '?')
          );
          return;
        }
        const senderOpenId = sender.sender_id && sender.sender_id.open_id;
        const senderUnionId = sender.sender_id && sender.sender_id.union_id;
        // 记录 union_id（跨应用自动化推送时让子应用正确寻址同一用户），无需额外飞书权限
        if (senderOpenId && senderUnionId) setUnionId(senderOpenId, senderUnionId);
        const messageId = msg.message_id;
        const chatType = msg.chat_type; // 'p2p' | 'group'
        const messageType = msg.message_type;

        if (!senderOpenId || !messageId) {
          console.log(`[feishu-ws:${label}] 缺 openId/messageId，跳过`);
          return;
        }

        // 群聊里只响应 @本机器人 的消息
        if (chatType === 'group' && (!msg.mentions || msg.mentions.length === 0)) {
          console.log(`[feishu-ws:${label}] 群消息未 @机器人，跳过 chat_id=${msg.chat_id}`);
          return;
        }

        // 内存去重：飞书重发/网络抖动时同一事件只处理一次
        if (isDuplicate(senderOpenId, messageId)) {
          console.log(
            `[feishu-ws:${label}] 重复事件去重 openId=${senderOpenId} mid=${messageId}（飞书重试或网络抖动，忽略）`
          );
          return;
        }

        const rawText =
          messageType === 'text'
            ? (() => {
                try {
                  return JSON.parse(msg.content || '{}').text || '';
                } catch {
                  return '';
                }
              })()
            : '';
        const text = resolveMentions(rawText, msg.mentions);

        let imageKey = null;
        if (messageType === 'image') {
          try {
            imageKey = JSON.parse(msg.content || '{}').image_key || null;
          } catch {
            imageKey = null;
          }
        }

        let fileMeta = null;
        if (messageType === 'file') {
          try {
            const c = JSON.parse(msg.content || '{}');
            fileMeta = { key: c.file_key, name: c.file_name, type: c.file_type, size: c.file_size };
          } catch {
            fileMeta = null;
          }
        }

        console.log(
          `[feishu-ws:${label}${agentId ? ` agent=${agentId}` : ''}] 收到消息 chat=${chatType} type=${messageType} openId=${senderOpenId} textLen=${text.length} img=${imageKey ? 'yes' : 'no'} file=${fileMeta ? fileMeta.type : 'no'} mid=${messageId}`
        );

        if (fileMeta) {
          setImmediate(() => {
            Promise.resolve()
              .then(async () => {
                if (CLOUD_DOC_TYPES.has(fileMeta.type)) {
                  await onMessage(senderOpenId, text, null, {
                    name: fileMeta.name,
                    type: fileMeta.type,
                    unsupported: true,
                    cloudDoc: true,
                  }, msg.chat_id, agentId, creds);
                  return;
                }
                let file = { name: fileMeta.name, type: fileMeta.type, size: fileMeta.size };
                try {
                  const dl = await downloadFile(messageId, fileMeta.key, creds);
                  if (!dl) {
                    await onMessage(senderOpenId, text, null, { unsupported: true, downloadSkipped: true }, msg.chat_id, agentId, creds);
                    return;
                  }
                  const ex = extractText(dl.buffer, fileMeta.name, dl.mime);
                  if (ex.unsupported) {
                    await onMessage(senderOpenId, text, null, ex, msg.chat_id, agentId, creds);
                    return;
                  }
                  if (ex.lowYield) {
                    await onMessage(senderOpenId, text, null, { ...ex, lowYield: true }, msg.chat_id, agentId, creds);
                    return;
                  }
                  const trunc = truncateExtracted(ex.text);
                  file = { ...file, text: trunc.text, truncated: trunc.truncated };
                } catch (e) {
                  console.error(`[feishu-ws:${label}] 文件处理失败:`, e.message);
                  await onMessage(senderOpenId, text, null, { unsupported: true, error: e.message }, msg.chat_id, agentId, creds);
                  return;
                }
                return onMessage(senderOpenId, text, null, file, msg.chat_id, agentId, creds);
              })
              .catch((e) => console.error(`[feishu-ws:${label}] onMessage(文件) 失败:`, e.message, e.stack));
          });
        } else if (text && text.trim()) {
          setImmediate(() => {
            Promise.resolve()
              .then(() => onMessage(senderOpenId, text.trim(), null, null, msg.chat_id, agentId, creds))
              .catch((e) => console.error(`[feishu-ws:${label}] onMessage 失败:`, e.message, e.stack));
          });
        } else if (imageKey) {
          setImmediate(() => {
            Promise.resolve()
              .then(async () => {
                let image = null;
                try {
                  image = await downloadImage(messageId, imageKey, creds);
                } catch (e) {
                  console.error(`[feishu-ws:${label}] 下载图片失败:`, e.message);
                }
                return onMessage(senderOpenId, '', image, null, msg.chat_id, agentId, creds);
              })
              .catch((e) => console.error(`[feishu-ws:${label}] onMessage(图片) 失败:`, e.message, e.stack));
          });
        } else {
          console.log(`[feishu-ws:${label}] 收到未支持的消息类型 type=${messageType}，跳过`);
        }
      } catch (e) {
        console.error(`[feishu-ws:${label}] 处理事件失败:`, e.message, e.stack);
      }
    },
  });
}

// 通用：为某个飞书应用（凭据）建立一条 WS 长连接。
function makeWsClient({ creds, label, agentId, onMessage }) {
  const appId = creds?.appId || process.env.FEISHU_APP_ID;
  const appSecret = creds?.appSecret || process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    console.warn(`[feishu-ws:${label}] 未配置凭据，长连接不启动。`);
    return null;
  }

  const ws = new WSClient({
    appId,
    appSecret,
    autoReconnect: true,
    onReconnected: () => console.log(`[feishu-ws:${label}] 连接已恢复（重连成功）。`),
    onError: (err) => {
      const msg = (err && err.message) ? err.message : String(err);
      console.error(`[feishu-ws:${label}] 连接错误:`, msg);
      if (/long.?connect|persistent|eventbus|not enabled|未开启|receive.*mode/i.test(msg)) {
        console.error(`[feishu-ws:${label}] 提示：请在飞书开放平台将该应用的「事件订阅 → 接收方式」改为「长连接（WebSocket）」，并订阅 im.message.receive_v1。`);
      }
    },
  });

  try {
    ws.start({ eventDispatcher: makeDispatcher({ creds, label, agentId, onMessage }) });
    console.log(`[feishu-ws:${label}] 长连接客户端已启动，等待飞书推送事件。`);
  } catch (e) {
    console.error(`[feishu-ws:${label}] 启动失败:`, e.message);
    return null;
  }
  return ws;
}

// 主应用（环境变量凭据）的长连接。
export function startFeishuConnection(onMessage) {
  if (_instances.has('main')) return;
  const ws = makeWsClient({ creds: null, label: 'main', agentId: null, onMessage });
  if (ws) _instances.set('main', ws);
}

// 为每个「已绑定飞书应用」的智能体建立独立的长连接。
export function startAgentConnections(onMessage) {
  const bound = listBoundAgents();
  for (const a of bound) {
    startOneAgentConnection(a, onMessage);
  }
}

// 单个智能体热启动长连接（绑定飞书应用后立即调用，无需重启服务）。
export function startOneAgentConnection(agent, onMessage) {
  if (!agent || !agent.appId || !agent.appSecret) return false;
  if (_instances.has(agent.id)) return true;
  const ws = makeWsClient({
    creds: { appId: agent.appId, appSecret: agent.appSecret },
    label: agent.id,
    agentId: agent.id,
    onMessage,
  });
  if (ws) {
    _instances.set(agent.id, ws);
    return true;
  }
  return false;
}

// 供 /health 等接口查询长连接状态
export function getFeishuWsStatus() {
  const statuses = {};
  for (const [label, ws] of _instances) {
    let status = 'unknown';
    try { status = ws ? ws.getConnectionStatus() : 'unknown'; } catch {}
    statuses[label] = status;
  }
  return { started: _instances.size > 0, connections: statuses };
}
