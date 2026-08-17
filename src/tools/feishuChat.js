// 飞书会话 / 消息读取工具：让 Acaily 能基于会话总结任务、待办、卡点。
// 两种视角：
//  - 机器人视角（默认）：只读机器人所在的会话（用户与它的私聊 + 被拉入的群）。
//  - 用户视角（context.userAccessToken 或 context.openId 命中已授权用户）：以该飞书用户身份
//    读取其全部私聊与所在群——这是凌云等自动化「以创建者视角总结今日三件事」的能力来源。
import { listBotChats, getChatMessages, resolveUserNames } from '../feishu/client.js';

// 列出会话：优先用户视角（创建者令牌），否则机器人视角
async function fmtChats(context = {}) {
  const ctx = context || {};
  // 用户视角：自动化以创建者身份读取其私聊 + 所在群（由 runner 注入 userAccessToken）
  if (ctx.userAccessToken) {
    const r = await listBotChats({ userAccessToken: ctx.userAccessToken });
    if (r.error) return `⚠️ ${r.error}`;
    if (!r.chats.length) return '当前飞书账号下没有可读取的会话（私聊或群聊）。';
    const lines = r.chats.map(
      (c, i) =>
        `${i + 1}. [${c.chat_type === 'p2p' ? '私聊' : '群'}] ${c.name}（成员 ${c.member_count || '?'}） chat_id=${c.chat_id}`
    );
    return '该飞书用户所在的会话如下（含私聊与所在群，将作为「今日三件事」等总结的数据来源）：\n' + lines.join('\n');
  }
  // 机器人视角（普通 @场景）
  const creds = ctx.feishuCreds;
  const r = await listBotChats({ creds });
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
  const ctx = context || {};
  const chatId = args.chat_id || ctx.chatId;
  if (!chatId) {
    return '⚠️ 缺少 chat_id：可先调用 feishu_my_chats 获取，或在群聊中直接 @我 时由我自动使用当前会话。';
  }
  // 用户视角优先（按 chat_type 决定 container_id_type：p2p 私聊 / chat 群聊）
  if (ctx.userAccessToken) {
    const r = await getChatMessages({
      chatId,
      pageSize: args.limit || 50,
      days: args.days,
      containerType: args.container_type === 'p2p' ? 'p2p' : 'chat',
      userAccessToken: ctx.userAccessToken,
    });
    if (r.error) return `⚠️ ${r.error}`;
    return formatHistory(r, ctx, args, null, true);
  }
  const creds = ctx.feishuCreds;
  const r = await getChatMessages({ chatId, pageSize: args.limit || 50, days: args.days, containerType: args.container_type === 'p2p' ? 'p2p' : 'chat', creds });
  if (r.error) return `⚠️ ${r.error}（需要应用具备 im:message:readonly 权限并已发布版本）`;
  return formatHistory(r, ctx, args, creds, false);
}

// 公共格式化：把某次 getChatMessages / getUserChatMessages 的结果整理成可读文本。
// @param asUser 是否以用户身份读取（影响身份锚定提示与边界说明）
// @param nameCreds 解析发送人姓名所用的飞书应用凭据（用户视角用主应用令牌解析组织成员）
async function formatHistory(r, ctx, args, nameCreds, asUser) {
  const d = r.diagnostics || { total: 0, readable: 0, typeCount: {} };
  // 诊断分支：先说清「是否真的读到了消息」，再决定如何总结
  if (d.total === 0) {
    return (
      '⚠️ 飞书接口对**该会话返回了 0 条消息**。这通常意味着以下之一：\n' +
      '1) 这是**最近才建立/加入**的会话——飞书规定只能读取授权后产生的消息，历史读不到；\n' +
      '2) 该会话近期确实没有任何消息；\n' +
      '3) 权限/发版未真正生效（可在开放平台「版本管理与发布」确认 im:message 已发布）。\n' +
      '若是情况 1，请把相关聊天记录复制/导出/转发成文本发给我，我立即按四部分整理。'
    );
  }
  if (d.readable === 0) {
    const types = Object.keys(d.typeCount).join('、') || '未知';
    return (
      `⚠️ 飞书接口返回了 ${d.total} 条消息，但**都是非文本类型（${types}）**——` +
      '例如图片、语音、文件、系统通知、转发卡片等。我目前只能解析「纯文本(text)」和「富文本(post)」，' +
      '无法读取图片/语音/文件里的文字。\n' +
      '请把会话里的任务信息以**文字形式**（复制关键对话、或导出聊天记录）发给我，我即可继续总结。'
    );
  }
  // 解析「当前飞书用户」的真实身份，作为任务归属锚点。
  // 否则 LLM 只能从群消息里猜「我是谁」，极易把别人的任务算到本人头上
  // （实测曾把王俏谊的任务当成孙旭峰的）。
  const curOpenId = (ctx && ctx.openId) || '';
  const openIds = r.messages.map((m) => m.sender_open_id);
  if (curOpenId) openIds.push(curOpenId);
  const names = await resolveUserNames(openIds, nameCreds);
  const curName = curOpenId ? names[curOpenId] || curOpenId : '';
  const identityLine = curName
    ? `【身份锚定】当前飞书用户 = ${curName}（open_id: ${curOpenId}）。\n` +
      `- 下方消息中，以「【你｜${curName}】」开头的行就是 ${curName} 本人发的消息；以其他姓名开头的行是群内其他成员发的。\n` +
      `- 总结「我的任务 / 待办 / 卡点」时，**只提取【你】名下的任务**，以及 @ 给【你】的任务（如「@${curName} 你负责X」）。\n` +
      `- 其他成员（如王俏谊等）的任务请单独列出、绝不算作 ${curName} 的；也不要编造「按你在群内的身份 XXX 整理」这类话——身份已由系统固定为 ${curName}。\n\n`
    : '';
  const lines = r.messages.map((m) => {
    const t = m.create_time
      ? new Date(m.create_time * 1000).toISOString().slice(0, 16).replace('T', ' ')
      : '?';
    const sender = names[m.sender_open_id] || m.sender_open_id;
    const isMe = curOpenId && m.sender_open_id === curOpenId;
    const prefix = isMe ? `【你｜${curName}】` : sender;
    return `[${t}] ${prefix}: ${m.text}`;
  });
  const scopeNote = asUser
    ? `（以下为该会话最近 ${d.readable} 条可读消息，原始 ${d.total} 条；以用户身份读取其全部私聊与所在群，仅含授权后产生的消息）`
    : `（以下为该会话最近 ${d.readable} 条可读消息，原始 ${d.total} 条；仅机器人所在的会话可读取，用户与其它人的私聊、未加入的群无法读取；机器人仅能读入群后的消息）`;
  return identityLine + scopeNote + '\n' + lines.join('\n');
}

export const feishuChatTools = [
  {
    name: 'feishu_my_chats',
    description:
      '列出飞书会话（名称、成员数、chat_id 与类型 group/私聊）。以用户身份运行时列出该用户全部的私聊与所在群；以机器人身份运行时仅列出机器人所在的群。参数 {}。用于定位要总结的会话。',
    run: async (_args, context) => fmtChats(context || {}),
  },
  {
    name: 'feishu_chat_history',
    description:
      '读取某个飞书会话的历史文本消息。参数：{"chat_id":"会话ID（来自 feishu_my_chats；省略则使用当前会话）","limit":条数(默认50),"days":仅取最近N天,"container_type":"chat(群,默认) 或 p2p(私聊)"}。以用户身份运行时可读该用户的私聊与所在群；以机器人身份运行时仅读机器人所在的会话。返回带时间和发送人的消息，供你总结已完成任务 / 待办 / 卡点 / 重点。',
    run: async (args, context) => fmtHistory(args || {}, context || {}),
  },
];
