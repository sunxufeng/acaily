// 简易 RBAC（T5.2）：管理员令牌校验。生产应接飞书通讯录/企业权限。
export function isAdmin(req) {
  const token = req.headers['x-admin-token'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  const expected = process.env.ACAILY_ADMIN_TOKEN;
  if (!expected) return false; // 未配置管理员令牌时默认关闭后台
  return token === expected;
}
