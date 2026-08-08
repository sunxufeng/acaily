# Acaily · 飞书 AI 助手（模型网关版）

复刻飞书 Aily 的 AI 对话 / 技能工作流 / 知识库能力，**核心差异化**是：
**组织内每位飞书用户可自配各自的模型 Provider（OpenAI 兼容 / Anthropic / Ollama / 自建网关）的 URL、API Key 与 Model 参数**，由「模型网关层」按飞书 `open_id` 路由并注入解密后的密钥。

> 对应交付物：需求说明书 `Acaily需求说明书.md`、实施计划 `Acaily实施计划.docx`、架构图 `Acaily架构图.svg`（见上级目录）。

## 架构（对齐 7 层架构图）

```
用户(飞书) → 接入层(事件/回调/open_id校验)
          → 应用服务层(会话/Agent Runtime/技能MCP/RAG)
          → 模型网关层★(按open_id路由 + KMS密钥保险库 + 多Provider适配 + 限流降级)
          → 外部 Provider(OpenAI兼容/Claude/Ollama/自建网关)
          → 数据层(对话历史/向量库/密文/审计) → 安全层
```

## 目录

```
src/
  crypto/kms.js          信封加密：DEK(AES-256-GCM) + KEK(主密钥env) 包裹，密钥不出库
  config/schema.js       用户模型配置校验 schema
  config/userConfigStore.js  配置持久化（JSON 文件）+ 密钥密文分离存储
  providers/             多 Provider 适配：base / openai / anthropic / ollama / custom + 注册表
  gateway/rateLimiter.js 令牌桶限流（按 open_id）
  gateway/router.js      网关路由：解析配置 → 解密 → 选适配器 → 限流/重试/降级
  feishu/event.js        飞书事件签名校验 + 消息抽取（open_id）
  feishu/client.js       飞书消息发送（占位，接 tenant_access_token）
  agent/runtime.js       Agent 规划-调用-反思闭环 + 工具注册中心
  server/app.js          HTTP 服务：/health /config /chat /agent/chat /feishu/event 等
public/settings.html     个人设置页 H5（Provider/Key/Model 配置 + 连通性测试）
test/                    node --test 单元测试（kms/providers/router/agent/rateLimiter）
```

## 快速开始

```bash
# 依赖（本工程零运行时依赖，仅用到 Node 内置 http/crypto；如需 npm 脚本可 npm i 占位）
export ACAILY_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
export ACAILY_CONFIG_STORE=/path/to/config.json      # 配置与密文存储文件
export FEISHU_APP_SECRET=xxx                          # 飞书事件签名校验（可选）
npm start                                             # 默认 3000 端口
```

## 测试

```bash
npm test          # node --test，覆盖 kms/providers/router/agent/rateLimiter
```

## 主要接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/health` | 存活检查 |
| POST | `/config` | 保存某用户（openId）模型配置，API Key 加密入库 |
| GET  | `/config/{openId}` 或 `/config?openId=` | 读取配置（API Key 脱敏） |
| POST | `/config/test` | 配置连通性测试（一键探测 Provider 可达性） |
| POST | `/chat` | 直连模型网关对话（messages[]） |
| POST | `/agent/chat` | 走 Agent Runtime（工具调用闭环） |
| POST | `/feishu/event` | 飞书事件回调入口（签名校验 + open_id 抽取） |
| GET  | `/ratelimit/{openId}` | 当前用户令牌桶剩余 |

## 安全要点

- 每个用户的 API Key 用 **envelope 加密**：随机 DEK 加密明文，KEK（主密钥）由环境变量 `ACAILY_MASTER_KEY` 托管；解密仅在内存中完成，密钥永不出库、不落盘明文。
- 读取配置接口对 API Key 脱敏（`hasApiKey` 布尔，不返回明文）。
- 按 `open_id` 做逻辑隔离，后续接数据层多租户物理隔离（T3.1）。
- 飞书事件回调按 `X-Lark-Signature` 校验，防止伪造请求。

## 当前进度（对齐看板 M0–M6）

- ✅ M0 立项/需求/计划/架构图（交付文档）
- ✅ M1 架构设计 + 模型网关 PoC（本工程：网关路由 + 多 Provider + KMS + Feishu 事件 + Agent 骨架 + 测试 + 冒烟）
- 🔧 M2 个人设置页 + 密钥保险库（KMS/多Provider/限流已落地；H5 设置页 v1 已提供）
- ⏳ M3 对话+Agent 闭环 / M4 RAG / M5 管理后台+合规 / M6 验收上线
