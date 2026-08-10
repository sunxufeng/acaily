// 飞书「应用管理」(Application Management) 客户端。
// 用于在组织内为某个智能体创建并绑定一个飞书自建应用（含机器人能力），
// 实现「新建的智能体 ↔ 飞书新建的应用」绑定。
// 依赖 tenant_access_token（需开放平台开通 application:application 权限）。

import { getTenantToken } from './client.js';

const FEISHU_HOST = process.env.FEISHU_HOST || 'https://open.feishu.cn';

/**
 * 在飞书组织内创建一个自建应用。
 * @param {{name:string, description?:string}} opts
 * @returns {Promise<{ok:boolean, appId?:string, appSecret?:string, code?:number, msg?:string}>}
 */
export async function createFeishuApp({ name, description }) {
  const token = await getTenantToken();
  const res = await fetch(`${FEISHU_HOST}/open-apis/application/v6/applications`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: (name || 'Acaily 智能体').slice(0, 50),
      description: (description || '由 Acaily 创建的智能体应用').slice(0, 200),
      app_type: 'custom',
    }),
  });
  const j = await res.json().catch(() => ({ code: -1, msg: '飞书返回非 JSON' }));
  if (j.code !== 0) {
    return { ok: false, code: j.code, msg: j.msg || '创建飞书应用失败' };
  }
  // 响应结构：data.app.{ app_id, app_secret, ... }
  const app = (j.data && (j.data.app || j.data.application)) || j.data || {};
  return {
    ok: true,
    appId: app.app_id,
    appSecret: app.app_secret,
  };
}

/**
 * 为已创建的应用启用「机器人」能力（让该应用可作为飞书机器人被 @ 对话）。
 * 该接口为可选增强：失败不阻断绑定主流程，仅返回告警信息。
 */
export async function enableBotCapability(appId) {
  const token = await getTenantToken();
  const res = await fetch(
    `${FEISHU_HOST}/open-apis/application/v6/applications/${appId}/capabilities/bot`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ bot: {} }),
    }
  );
  const j = await res.json().catch(() => ({ code: -1 }));
  return { ok: j.code === 0, code: j.code, msg: j.msg };
}
