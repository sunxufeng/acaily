// 合规自检清单（T5.3）：枚举关键控制项，供等保/SOC2 自评与整改跟踪。
export const COMPLIANCE_CHECKLIST = [
  { id: 'C1', domain: '加密', control: '用户 API Key 信封加密（DEK+AES-256-GCM，KEK 由 KMS/env 托管）', status: 'done' },
  { id: 'C2', domain: '隔离', control: '按 open_id 逻辑租户隔离（配置/会话/历史越权不可见）', status: 'done' },
  { id: 'C3', domain: '传输', control: '飞书事件回调 X-Lark-Signature 签名校验', status: 'done' },
  { id: 'C4', domain: '审计', control: '配置变更/对话/密钥访问全链路审计日志', status: 'done' },
  { id: 'C5', domain: '最小化', control: 'API Key 读取脱敏，明文密钥不出服务端、不落盘', status: 'done' },
  { id: 'C6', domain: '可用性', control: '限流（令牌桶）+ 重试退避 + 降级', status: 'done' },
  { id: 'C7', domain: '合规', control: '等保/SOC2 外部评估与渗透测试（待排期）', status: 'pending' },
  { id: 'C8', domain: '合规', control: '数据留存与销毁策略、用户数据导出/删除（待排期）', status: 'pending' },
];

// 自检：返回已落实与待办
export function selfAssess() {
  const done = COMPLIANCE_CHECKLIST.filter((c) => c.status === 'done').map((c) => c.id);
  const pending = COMPLIANCE_CHECKLIST.filter((c) => c.status === 'pending').map((c) => c.id);
  return { total: COMPLIANCE_CHECKLIST.length, done, pending, ready: pending.length === 0 };
}
