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
  const safeName = (name || 'Acaily 智能体').slice(0, 50);
  const safeDesc = (description || '由 Acaily 创建的智能体应用').slice(0, 200);
  const token = await getTenantToken();
  // 飞书 v6 创建应用必填 i18n 数组（i18n_key 枚举：zh_cn/en_us/ja_jp/...），否则返回 "field validation failed"。
  // 此处用 zh_cn 写入名称/描述；多语言可后续 PATCH。
  const res = await fetch(`${FEISHU_HOST}/open-apis/application/v6/applications`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      app_type: 'custom',
      i18n: [
        {
          i18n_key: 'zh_cn',
          name: safeName,
          description: safeDesc,
        },
      ],
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

/**
 * 校验用户提供的 app_id / app_secret 是否合法（通过尝试获取 tenant_access_token）。
 * 用于「手动绑定已有飞书应用」场景：用户自己去 open.feishu.cn/app 创建应用后，
 * 把 app_id + app_secret 填进 Acaily，本函数先验证凭据是否有效，再保存。
 *
 * @param {{appId:string, appSecret:string}} creds
 * @returns {Promise<{ok:boolean, code?:number, msg?:string}>}
 */
export async function validateFeishuCredentials({ appId, appSecret }) {
  if (!appId || !appSecret) return { ok: false, msg: '请填写 app_id 和 app_secret' };
  try {
    const res = await fetch(`${FEISHU_HOST}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: String(appId).trim(), app_secret: String(appSecret).trim() }),
    });
    const j = await res.json().catch(() => ({ code: -1, msg: '飞书返回非 JSON' }));
    if (j.code === 0) return { ok: true };
    return { ok: false, code: j.code, msg: j.msg || '凭据无效' };
  } catch (e) {
    return { ok: false, msg: '网络错误：' + e.message };
  }
}
