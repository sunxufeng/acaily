# Acaily 运维手册 / FAQ（培训材料 T6.2）

## 启动

```bash
export ACAILY_MASTER_KEY=<32字节hex主密钥>
export ACAILY_CONFIG_STORE=/data/acaily-config.json   # 用户模型配置+密文
export ACAILY_CONV_STORE=/data/acaily-conversations.json
export ACAILY_AUDIT_STORE=/data/acaily-audit.json
export ACAILY_ADMIN_TOKEN=<后台管理员令牌>
export FEISHU_APP_ID=<飞书应用ID> FEISHU_APP_SECRET=< secret >   # 飞书消息收发
npm start   # 默认 3000
```

## 健康检查

- `GET /health` → `{"ok":true,...}`。接入负载均衡/容器探针。

## 常见问题

**Q1 用户配置存在哪？密钥安全吗？**
配置与密文在 `ACAILY_CONFIG_STORE`（JSON）。API Key 用 envelope 加密（DEK+AES-256-GCM，KEK=`ACAILY_MASTER_KEY`），明文仅运行时内存存在，不出服务端、不落盘。读取接口脱敏（只返回 hasApiKey）。

**Q2 怎么加/改用户模型？**
用户访问 `/settings`（生产嵌入飞书工作台，open_id 由登录注入），填 Provider/URL/Key/Model → 保存。或管理员协助。

**Q3 限流怎么调？**
`src/gateway/rateLimiter.js` 默认每用户令牌桶容量 20、补充速率 1/s。按需改常量后重启。

**Q4 接真实向量库（RAG）？**
`src/rag/vectorStore.js` 是统一接口；实现 `upsert/search` 对接 pgvector/Milvus/Qdrant 即可替换内存版，检索器与提示词无需改。

**Q5 接真实嵌入/模型？**
嵌入：`src/rag/embeddings.js` 的 `EmbeddingService` 换成 OpenAI/通义 embedding。模型：设置页选对应 Provider 并填 URL/Key 即可，无需改代码。

**Q6 后台怎么用？**
`GET /admin/stats`（用量）、`/admin/audit`（审计）、`/admin/compliance`（合规自检），均需 `X-Admin-Token` 头。

## 故障 Runbook

- 服务起不来：检查 `ACAILY_MASTER_KEY` 是否设置；看启动日志 `[acaily] 服务已启动`。
- 对话 502：下游 Provider 不可达/密钥错 → 看 /admin/audit 的 chat.error；引导用户用「连通性测试」自查。
- 配置丢失：确认 `ACAILY_CONFIG_STORE` 路径与挂载持久化（容器场景挂卷）。
- 安全事件：审计日志含 key.decrypt 记录，结合访问源排查。
