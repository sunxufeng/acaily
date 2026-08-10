// 读取飞书云文档（在线文档）正文：当用户在对话里发来飞书文档链接（docx / doc / wiki）时，
// 服务端用开放平台 API 直接拉取正文，注入给模型，避免模型去联网抓「需要登录」的网页。
//
// 依赖：应用需在飞书开放平台开通「docx:document:readonly」「wiki:wiki:readonly」权限（tenant 身份）。
// 文档本身需对机器人可读：把文档「协作人」加上机器人，或保持「获得链接的人可阅读」。
//
// 说明：sheets / base / bitable / mindnote / slides 走不同 API，暂不在本模块自动读取，
// 命中这些类型时由调用方给出友好提示（建议导出后发送）。

const FEISHU_HOST = 'https://open.feishu.cn';

import { getTenantToken } from './client.js';

// 飞书云文档链接识别（保留常用类型；docx/doc/wiki 走对应 API 自动读取）
// 例：https://ccnyntd8vksu.feishu.cn/docx/SMWBd968FoZXe9xIQpncXt6PnAd
// 例：https://<tenant>.feishu.cn/wiki/<node_token>
const SUPPORTED = new Set(['docx', 'doc', 'wiki']);
const LINK_RE = /https?:\/\/[a-z0-9-]*\.feishu\.cn\/(docx|doc|sheet|sheets|wiki|base|bitable|mindnote|slides)\/([A-Za-z0-9]+)/gi;

export function extractFeishuDocLinks(text = '') {
  const out = [];
  const re = new RegExp(LINK_RE.source, 'gi');
  let m;
  while ((m = re.exec(text))) {
    out.push({ type: m[1].toLowerCase(), token: m[2], url: m[0] });
  }
  return out;
}

// 是否命中「可自动读取」的云文档类型（docx / doc / wiki）
export function isReadableCloudDoc(link) {
  return link && SUPPORTED.has(link.type);
}

// Wiki node_token → 实际 docx obj_token（docx API 读正文必须用 obj_token）
async function resolveWikiNodeObjToken(t, nodeToken) {
  const url = `${FEISHU_HOST}/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(nodeToken)}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${t}` } });
  const j = await r.json().catch(() => ({}));
  if (j.code !== 0) {
    return { ok: false, code: j.code, msg: j.msg || `HTTP ${r.status}` };
  }
  const node = j.data && j.data.node;
  if (!node || !node.obj_token) {
    return { ok: false, code: -1, msg: 'wiki 节点解析失败（缺少 obj_token）' };
  }
  return { ok: true, objToken: node.obj_token, objType: node.obj_type };
}

// 通用：拉文档正文（docx API）—— 接受 obj_token + 原始 URL 作为 fallback 提示
async function fetchDocxRaw(t, objToken) {
  const res = await fetch(`${FEISHU_HOST}/open-apis/docx/v1/documents/${objToken}/raw_content`, {
    headers: { authorization: `Bearer ${t}` },
  });
  return res.json().catch(() => ({}));
}

// 读取飞书 docx / doc 正文（保持向后兼容），返回 { ok, text?, error?, code?, hint? }
export async function fetchFeishuDoc(token) {
  const t = await getTenantToken();
  if (!t) return { ok: false, error: '未配置飞书凭据，无法读取云文档' };
  const j = await fetchDocxRaw(t, token);
  if (j.code !== 0) {
    return hintFromJ(j);
  }
  const content = (j.data && j.data.content) || '';
  if (!content.trim()) {
    return { ok: false, error: '文档正文为空或暂不支持提取', hint: '请尝试导出为 Word / PDF 后发送，或直接把正文粘贴到对话框。' };
  }
  return { ok: true, text: content };
}

// 读取飞书 Wiki 节点正文：先 resolve node_token → obj_token，再走 docx raw_content
export async function fetchFeishuWiki(nodeToken) {
  const t = await getTenantToken();
  if (!t) return { ok: false, error: '未配置飞书凭据，无法读取飞书 Wiki', hint: '请配置 FEISHU_APP_ID / FEISHU_APP_SECRET。' };
  const r = await resolveWikiNodeObjToken(t, nodeToken);
  if (!r.ok) {
    let hint = '请在飞书开放平台给应用开通「wiki:wiki:readonly」权限，并把该 Wiki「协作人」加上机器人。权限开通后通常几分钟内生效。';
    return { ok: false, error: r.msg, code: r.code, hint };
  }
  const j = await fetchDocxRaw(t, r.objToken);
  if (j.code !== 0) {
    return hintFromJ(j);
  }
  const content = (j.data && j.data.content) || '';
  if (!content.trim()) {
    return { ok: false, error: 'Wiki 正文为空或暂不支持提取', hint: '请尝试导出为 Word / PDF 后发送，或直接把正文粘贴到对话框。' };
  }
  return { ok: true, text: content, objType: r.objType };
}

function hintFromJ(j) {
  const msg = j.msg || `HTTP ${j.code || 0}`;
  let hint = '';
  if (/scope|permission|权限/i.test(msg)) {
    hint = '请在飞书开放平台给应用开通「docx:document:readonly」权限；同时确认文档对机器人可读（把「协作人」加上机器人，或保持「获得链接的人可阅读」）。权限开通后通常几分钟内生效。';
  } else if (/not found|不存在|invalid/i.test(msg)) {
    hint = '文档不存在或链接无效，请确认链接完整（复制整段 URL 再发送）。';
  } else {
    hint = '该文档暂时无法读取，可导出为 Word / PDF 后作为文件发送，或直接粘贴正文。';
  }
  return { ok: false, error: msg, code: j.code, hint };
}
