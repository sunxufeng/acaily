// 飞书会话 / 消息读取工具：让 Acaily 能基于「机器人所在的会话」总结任务、待办、卡点。
// 关键边界：机器人只能读取它所在的会话（与用户的私聊 + 被拉入的群），
// 无法读取用户与其它人的私聊、也无法读取未加入的群——这是飞书平台安全模型决定的。
import { listBotChats, getChatMessages, resolveUserNames } from '../feishu/client.js';

// 列出机器人所在的群聊
async function fmtChats() {
  const r = await listBotChats();
  if (r.error) return `⚠️ ${r.error}（需要应用具备 im:chat 权限并已发布版本）`;
  if (!r.chats.length) {
    return '当前机器人还没有加入任何群聊。如需总结群里的任务，请先把机器人拉进相关群聊（在群里 @它 即可）。';
  }
  const lines = r.chats.map(
    (c, i) =>
      `${i + 1}. [${c.chat_type === 'group' ? '群' : '会话'}] ${c.name}（成员 ${c.member_count || '?'}） chat_id=${c.chat_id}`
  );
  return '机器人所在的群聊如下（仅这些可被读取；私聊与未加入的群无法读取）：\n' + lines.join('\n');
}

// 读取某个会话的历史文本消息，解析发送人姓名并格式化
async function fmtHistory(args = {}, context = {}) {
  const chatId = args.chat_id || (context && context.chatId);
  if (!chatId) {
    return '⚠️ 缺少 chat_id：可先调用 feishu_my_chats 获取，或在群聊中直接 @我 时由我自动使用当前会话。';
  }
  const r = await getChatMessages({ chatId, pageSize: args.limit || 50, days: args.days });
  if (r.error) return `⚠️ ${r.error}（需要应用具备 im:message:readonly 权限并已发布版本）`;
  if (!r.messages.length) return '该会话近期没有可读的文本消息。';

  const names = await resolveUserNames(r.messages.map((m) => m.sender_open_id));
  const lines = r.messages.map((m) => {
    const t = m.create_time
      ? new Date(m.create_time * 1000).toISOString().slice(0, 16).replace('T', ' ')
      : '?';
    return `[${t}] ${names[m.sender_open_id] || m.sender_open_id}: ${m.text}`;
  });
  return (
    `（以下为该会话最近 ${r.messages.length} 条文本消息；仅机器人所在的会话可读取，` +
    `用户与其它人的私聊、未加入的群无法读取）\n` +
    lines.join('\n')
  );
}

export const feishuChatTools = [
  {
    name: 'feishu_my_chats',
    description:
      '列出飞书机器人所在的所有群聊（名称、成员数、chat_id）。用于定位要总结的群。参数 {}。注：机器人无法列出与用户的私聊，也无法读取未加入的群。',
    run: async () => fmtChats(),
  },
  {
    name: 'feishu_chat_history',
    description:
      '读取某个飞书会话的历史文本消息（仅限机器人所在的会话：你与它的私聊、或你把它拉进去的群）。参数：{"chat_id":"会话ID（来自 feishu_my_chats；省略则使用当前会话）","limit":条数(默认50),"days":仅取最近N天}。返回带时间和发送人的消息，供你总结已完成任务 / 待办 / 卡点 / 重点。',
    run: async (args, context) => fmtHistory(args || {}, context || {}),
  },
];
