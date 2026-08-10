// 飞书 OAuth2 网页登录 + 签名会话（零依赖）。
// 设计要点：
//  - 登录走飞书授权码流程（authorization_code），天然限定在应用「可见范围」内的组织成员。
//  - 会话用 HMAC-SHA256 签名的 httpOnly Cookie，服务端不可伪造、客户端不可篡改。
//  - open_id 永远由服务端会话注入，绝不信任客户端请求体里的 openId（杜绝越权改他人配置）。

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'acaily_sid';
const STATE_NAME = 'acaily_oauth_state';
const MAX_AGE = 60 * 60 * 24 * 7; // 7 天
const FEISHU_HOST = process.env.FEISHU_HOST || 'https://open.feishu.cn';

function getSecret() {
  const s = process.env.ACAILY_SESSION_SECRET || process.env.ACAILY_MASTER_KEY;
  if (!s) throw new Error('ACAILY_SESSION_SECRET 或 ACAILY_MASTER_KEY 未设置');
  return s;
}

// 授权与换票必须共用同一个 redirect_uri，否则飞书报 20063（redirect_uri 不一致）。
function getRedirectUri() {
  return process.env.ACAILY_OAUTH_REDIRECT_URI || 'https://acaily.areteailab.com/oauth/callback';
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function fromB64url(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}
function sign(payloadB64) {
  return b64url(createHmac('sha256', getSecret()).update(payloadB64).digest());
}
function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function encodeSession(user) {
  const payload = { ...user, exp: Date.now() + MAX_AGE * 1000 };
  const pB64 = b64url(JSON.stringify(payload));
  return `${pB64}.${sign(pB64)}`;
}

export function decodeSession(cookie) {
  if (!cookie) return null;
  const [pB64, sig] = cookie.split('.');
  if (!pB64 || !sig) return null;
  if (!safeEqual(sig, sign(pB64))) return null;
  try {
    const payload = JSON.parse(fromB64url(pB64).toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

export function parseSession(req) {
  return decodeSession(parseCookies(req.headers.cookie || '')[COOKIE_NAME]);
}

function isHttps(req) {
  const proto = req.headers['x-forwarded-proto'] || '';
  if (proto.split(',').map((s) => s.trim()).includes('https')) return true;
  return !!req.socket && !!req.socket.encrypted;
}

function serializeCookie(name, value, opts) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function setSessionCookie(res, user, req) {
  const val = encodeSession(user);
  const secure = process.env.ACAILY_COOKIE_SECURE !== 'false' && (!req || isHttps(req));
  // SameSite=None：允许浏览器插件（chrome-extension://）以跨站 iframe 形式复用同一飞书登录会话。
  // 仅当 secure=true（HTTPS）时 None 才生效；本地 HTTP 调试时浏览器会回退为 Lax，不影响同站使用。
  const sameSite = process.env.ACAILY_COOKIE_SAMESITE || 'None';
  res.setHeader(
    'Set-Cookie',
    serializeCookie(COOKIE_NAME, val, { maxAge: MAX_AGE, httpOnly: true, sameSite, secure })
  );
}

export function clearSessionCookie(res) {
  const sameSite = process.env.ACAILY_COOKIE_SAMESITE || 'None';
  res.setHeader(
    'Set-Cookie',
    serializeCookie(COOKIE_NAME, '', { maxAge: 0, httpOnly: true, sameSite, path: '/' })
  );
}

export function setOauthState(res) {
  const state = randomBytes(16).toString('hex');
  const sameSite = process.env.ACAILY_COOKIE_SAMESITE || 'None';
  res.setHeader(
    'Set-Cookie',
    serializeCookie(STATE_NAME, state, { maxAge: 300, httpOnly: true, sameSite, path: '/' })
  );
  return state;
}

export function getOauthState(req) {
  return parseCookies(req.headers.cookie || '')[STATE_NAME];
}

// ---------------- 飞书 OAuth 流程 ----------------

export function getFeishuAuthorizeUrl(state) {
  const appId = process.env.FEISHU_APP_ID;
  const redirect = getRedirectUri();
  return (
    `${FEISHU_HOST}/open-apis/authen/v1/authorize` +
    `?app_id=${encodeURIComponent(appId)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}` +
    `&state=${encodeURIComponent(state)}`
  );
}

export async function exchangeCodeForToken(code) {
  // 注意：v2 token 端点严格要求 body 用 client_id / client_secret（不是 app_id / app_secret）。
  // 用错键名会导致飞书无法识别应用、进而无法匹配已登记的重定向 URI，报 20063。
  const clientId = process.env.FEISHU_APP_ID;
  const clientSecret = process.env.FEISHU_APP_SECRET;
  const redirectUri = getRedirectUri();
  const r = await fetch(`${FEISHU_HOST}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // 必须带 redirect_uri，且与授权请求、后台登记三者完全一致，否则飞书报 20063。
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });
  const j = await r.json();
  if (j.code !== 0) {
    // 把我们用到的 redirect_uri / client_id 一并带出，方便对照飞书后台排查。
    console.error('[oauth] 换票失败', {
      code: j.code,
      msg: j.msg,
      client_id: clientId,
      redirect_uri: redirectUri,
    });
    throw new Error(
      `飞书换票失败 code=${j.code} msg=${j.msg || '(无 msg)'} | client_id=${clientId} | redirect_uri=${redirectUri}`
    );
  }
  // v2 token 响应是扁平结构（access_token / open_id 等直接在顶层），
  // v1 才有 data 包裹。两者都兼容：优先取 data，否则用顶层对象。
  const tokenData = j.data || j;
  if (!tokenData || !tokenData.access_token) {
    console.error('[oauth] 换票响应缺少 access_token', j);
    throw new Error('飞书换票响应缺少 access_token，请检查响应结构');
  }
  return tokenData; // { access_token, open_id?, expires_in, ... }
}

export async function fetchFeishuUserInfo(accessToken) {
  const r = await fetch(`${FEISHU_HOST}/open-apis/authen/v1/user_info`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`飞书用户信息失败 code=${j.code} msg=${j.msg}`);
  return j.data; // { open_id, name, avatar_url, email, ... }
}
