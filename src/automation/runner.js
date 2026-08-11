// 自动化（T7.2）：执行器。
// 由 scheduler 或「立即运行」按钮触发：
//   1. 调 agent（用 pushTo[0] 的模型/身份/系统提示）
//   2. 把结果推送给 pushTo 中所有 open_id
//   3. 落 run 日志到 store + 审计

import { getConfig } from '../config/userConfigStore.js';
import { routeChat, routeChatConfig } from '../gateway/router.js';
import { sendMarkdown, sendText } from '../feishu/client.js';
import { record as auditRecord } from '../audit/auditLog.js';
import { appendRun, updateRun } from './store.js';
import { getAgent, getAgentApiKey, getAgentFeishuSecret } from '../config/agentStore.js';

// 由 app.js 在启动时注入依赖，避免循环引用
let deps = null;
export function initRunner(d) {
  deps = d;
}

// 由智能体对象拼出人设系统提示（与 app.js buildAgentSystemPrompt 同口径，但放在 runner 内避免循环依赖）
function buildAgentPersona(agent) {
  const parts = [`你正在以智能体「${agent.name}」${agent.emoji || ''} 的身份执行自动化任务。`];
  if (agent.description) parts.push(`简介：${agent.description}`);
  if (agent.identity) parts.push(`【身份 IDENTITY】\n${agent.identity}`);
  if (agent.user) parts.push(`【用户 USER】\n${agent.user}`);
  if (agent.soul) parts.push(`【灵魂 SOUL】\n${agent.soul}`);
  return parts.join('\n\n');
}

// 把「当前用户身份锁定」拼到系统提示里：与 app.js injectIdentityPrompt 行为一致，
// 防止 agent 在自动总结场景下误把别人的任务算到 pushTo[0] 名下。
function buildSystemPrompt(openId, baseAgent) {
  const cfg = getConfig(openId);
  const name = (cfg && cfg.displayName) || '';
  const sys = (cfg && baseAgent.buildUserSystemPrompt(cfg)) || baseAgent.systemPrompt;
  if (!name) return sys;
  return (
    sys +
    `\n\n【当前用户身份锁定】你正以飞书用户「${name}」（open_id: ${openId}）的身份服务。` +
    `身份已由系统固定为 ${name}，请以它为准整理「我的」任务，` +
    `且不要把其他成员的任务算到 ${name} 头上。`
  );
}

// 把 agent 输出渲染成飞书卡片正文，加标题与时间戳
function buildPushText(auto, answer) {
  const now = new Date();
  const ts = now.toISOString().slice(0, 16).replace('T', ' ');
  const head = `**${auto.title}**\n${ts}`;
  // 截掉过长的工具声明残留
  const clean = (answer || '').replace(/TOOL:[^\n]*\n?/g, '').trim();
  return `${head}\n\n${clean}`;
}

export async function runAutomation(auto, { manual = false } = {}) {
  if (!deps || !deps.agent) throw new Error('runner 未初始化（initRunner 未调用）');
  const { agent } = deps;
  if (!Array.isArray(auto.pushTo) || auto.pushTo.length === 0) {
    throw new Error('自动化未配置推送目标 pushTo');
  }
  const caller = auto.pushTo[0]; // 推送收件人（首个也用于飞书会话类工具的身份上下文）

  // 关联智能体：优先用其自有模型 + 人设；智能体没配模型时回退到 caller 的个人配置
  const linkedAgent = auto.agentId ? getAgent(auto.agentId) : null;
  let useAgentModel = false;
  let agentCfg = null;
  let agentApiKey = null;
  let agentPersona = null;
  // 智能体绑定的飞书应用凭据（appId + appSecret）：用于让回复以该智能体的机器人身份发送
  // 没绑定飞书应用时为 null，回退到主应用（process.env）身份
  let agentFeishuCreds = null;
  if (linkedAgent && (linkedAgent.provider || linkedAgent.providerPoolId)) {
    useAgentModel = true;
    agentCfg = {
      id: linkedAgent.id,
      name: linkedAgent.name,
      provider: linkedAgent.provider,
      model: linkedAgent.model,
      baseUrl: linkedAgent.baseUrl,
      displayName: linkedAgent.name,
      providerPoolId: linkedAgent.providerPoolId || null,
    };
    agentApiKey = linkedAgent.providerPoolId ? null : getAgentApiKey(linkedAgent.id);
    agentPersona = buildAgentPersona(linkedAgent);
  }
  if (linkedAgent && linkedAgent.feishuAppId) {
    const secret = getAgentFeishuSecret(linkedAgent.id);
    if (secret) {
      agentFeishuCreds = { appId: linkedAgent.feishuAppId, appSecret: secret };
    }
  }

  if (!useAgentModel && !getConfig(caller)) {
    // 既没绑定智能体模型，主叫用户也未配置模型 → 推一条错误回所有收件人
    const errText = `⚠️ 自动化「${auto.title}」无法执行：未关联有效智能体，且收件人 ${caller} 尚未配置模型。请在个人设置页先填写 Provider / API Key / Model，或在自动化里关联一个智能体。`;
    for (const uid of auto.pushTo) {
      try { await sendText(uid, errText, agentFeishuCreds); } catch {}
    }
    await appendRun(auto.id, { durationMs: 0, status: 'err', error: 'caller 未配置模型且未关联智能体' });
    return { status: 'err', error: 'caller 未配置模型且未关联智能体' };
  }

  const t0 = Date.now();
  // 先写一条 running 占位，避免 UI 长时间没动静；记下 ts 用于后续 in-place 更新
  const placeholderTs = Date.now();
  await appendRun(auto.id, { ts: placeholderTs, durationMs: 0, status: 'running' });

  let answer = '';
  let errMsg = '';
  try {
    // 自动化默认给更多轮工具调用（10 步），也允许在自动化配置里单独覆盖
    const autoMaxSteps = Number.isFinite(auto.maxSteps) && auto.maxSteps > 0 ? auto.maxSteps : 10;
    const r = await agent.run(auto.description, {
      chat: (messages) =>
        useAgentModel
          ? routeChatConfig(agentCfg, agentApiKey, messages, { model: linkedAgent.model || null })
          : routeChat(caller, messages),
      history: [],
      systemPrompt: useAgentModel ? agentPersona : buildSystemPrompt(caller, agent),
      maxSteps: autoMaxSteps,
      context: { openId: caller, automationId: auto.id, automationTitle: auto.title, agentId: linkedAgent ? linkedAgent.id : null },
    });
    answer = r.answer || '';
  } catch (e) {
    errMsg = e.message || String(e);
    console.error(`[automation] 执行失败 (${auto.title}):`, errMsg);
  }

  const durationMs = Date.now() - t0;
  const preview = (answer || errMsg).slice(0, 160);

  if (answer) {
    // 推送到所有收件人（失败的单条不影响其它）；使用关联智能体绑定的飞书应用身份发送
    const pushText = buildPushText(auto, answer);
    for (const uid of auto.pushTo) {
      try {
        await sendMarkdown(uid, pushText, agentFeishuCreds);
      } catch (e) {
        try { await sendText(uid, pushText, agentFeishuCreds); } catch {}
        console.error(`[automation] 推送给 ${uid} 失败:`, e.message);
      }
    }
  }

  const finalStatus = errMsg ? 'err' : 'ok';
  // in-place 更新占位行：避免 UI 看到「执行中 0ms」一直挂着
  const updated = await updateRun(auto.id, placeholderTs, {
    durationMs,
    status: finalStatus,
    error: errMsg,
    preview,
  });
  // 兜底：万一占位因为并发原因没找到，再追加一条（数据最多冗余 1 行）
  if (!updated) {
    await appendRun(auto.id, { durationMs, status: finalStatus, error: errMsg, preview });
  }

  try {
    await auditRecord({
      actor: caller,
      action: manual ? 'automation.manual_run' : 'automation.run',
      target: auto.id,
      level: errMsg ? 'error' : 'info',
      meta: { title: auto.title, durationMs, pushTo: auto.pushTo.length, status: finalStatus },
    });
  } catch {}

  return { status: finalStatus, durationMs, answer, error: errMsg };
}