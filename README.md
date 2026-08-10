# Acaily · 飞书 AI 助手（模型网关版）

复刻飞书 Aily 的 AI 对话 / 技能工作流 / 知识库能力，**核心差异化**是：
**组织内每位飞书用户可自配各自的模型 Provider（OpenAI 兼容 / Anthropic / Ollama / 自建网关 / Acplugin）的 URL、API Key 与 Model 参数**，由「模型网关层」按飞书 `open_id` 路由并注入解密后的密钥。

> 对应交付物：需求说明书 `Acaily需求说明书.md`、实施计划 `Acaily实施计划.docx`、架构图 `Acaily架构图.svg`（见上级目录）。

## 架构（对齐 7 层架构图）

```
用户(飞书) → 接入层(事件/回调/open_id校验)
          → 应用服务层(会话/Agent Runtime/技能MCP/RAG)
          → 模型网关层★(按open_id路由 + KMS密钥保险库 + 多Provider适配 + 限流降级)
          → 外部 Provider(OpenAI兼容/Claude/Ollama/自建网关/Acplugin)
          → 数据层(对话历史/向量库/密文/审计) → 安全层
```

## 目录

```
src/
  crypto/kms.js          信封加密：DEK(AES-256-GCM) + KEK(主密钥env) 包裹，密钥不出库
  config/schema.js       用户模型配置校验 schema
  config/userConfigStore.js  配置持久化（JSON 文件）+ 密钥密文分离存储
  providers/             多 Provider 适配：base / openai / anthropic / ollama / custom / acplugin + 注册表
  gateway/rateLimiter.js 令牌桶限流（按 open_id）
  gateway/router.js      网关路由：解析配置 → 解密 → 选适配器 → 限流/重试/降级
  feishu/event.js        飞书事件签名校验 + 消息抽取（open_id）
  feishu/client.js       飞书消息发送（占位，接 tenant_access_token）
  agent/runtime.js       Agent 规划-调用-反思闭环 + 工具注册中心
  automation/store.js    自动化 JSON 持久化 + cron 表达式构造工具
  automation/scheduler.js cron 调度生命周期（croner 引擎）
  automation/runner.js   自动化执行器（调 agent + 飞书推送）
  server/app.js          HTTP 服务：/health /config /chat /agent/chat /feishu/event 等
public/settings.html     个人设置页 H5（Provider/Key/Model 配置 + 连通性测试）
public/admin.html        管理后台（仪表盘/用户管理/审计日志/自动化）
test/                    node --test 单元测试（kms/providers/router/agent/rateLimiter/admin/automation）
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
npm test          # node --test，覆盖 kms/providers/router/agent/rateLimiter/admin/automation
```

## 自动化（T7.2）

参考 aily 工作台·自动化页：在管理后台「⚙️ 自动化」标签里配置定时任务。

- **触发器**：5 字段标准 cron 表达式（UI 上提供「每天/每周/每月」快速生成），可勾选「闲时执行（00:00–06:00）」把任务推到空闲窗口执行。
- **推送目标**：1..N 个飞书 `open_id`，首个用于调模型（决定 Provider / API Key / 身份锁定），其余收推送。
- **执行器**：`automation/runner.js` 通过 `agent.run(description, ...)` 复用现有模型网关与身份锚定，结果用 `sendMarkdown` 推给所有目标。
- **运行日志**：每次执行追加到 `runs[]`（最多保留 20 条），UI 行内展示最近 5 条。
- **持久化**：`ACAILY_AUTOMATION_STORE`（默认 `data/automations.json`），重启自动重排。

API（需管理员）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET    | `/api/admin/automations` | 列出全部（含运行日志摘要）+ 活动 job 数 |
| POST   | `/api/admin/automations` | 新建；启用即挂 cron |
| PATCH  | `/api/admin/automations/:id` | 更新；重排 cron |
| DELETE | `/api/admin/automations/:id` | 删除；取消 cron |
| POST   | `/api/admin/automations/:id/run` | 立即运行（异步） |

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
| GET  | `/api/admin/usage?range=30d` | **使用统计**（需管理员）：summary / byModel / trend / byUser 四维聚合；写入侧落 `data/usage.jsonl` |
| GET  | `/api/admin/automations` / POST / PATCH / DELETE / POST `…/run` | **自动化**（需管理员）：cron 调度 + 飞书推送 |

### 个人模型配置字段（`/settings` & 管理端编辑）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `configName` | string≤60 | — | 个人展示名（如「Richard OpenAI」） |
| `provider` | enum | — | openai / anthropic / ollama / custom / acplugin |
| `apiKey` | string | — | 信封加密入库；留空=沿用已存密钥（`clearApiKey:true` 时清除） |
| `baseUrl` | http(s) URL | — | 兼容网关默认 `/v1` 结尾；Ollama 默认 `:11434` |
| `model` | string | — | 默认模型（首项） |
| `models` | string[]≤32 | — | 多行模型列表，首项同步进 `model` |
| `chatCompletionsPath` | string | `/chat/completions` | 自建网关可改 |
| `temperature` | 0..2 | 0.7 | 基础采样 |
| `maxTokens` | int≥1 | 2048 | 单次最大输出 |
| `topP` | 0..1 | 1 | 核采样 |
| `topK` | int≥1 | — | 部分模型支持（如 Gemini） |
| `frequencyPenalty` | -2..2 | 0 | 频率惩罚，降低重复 |
| `presencePenalty` | -2..2 | 0 | 出现惩罚，增加新鲜 |
| `multimodal` | bool | false | 图像输入能力开关（仅声明） |
| `stream` | bool | true | 流式输出；取消勾选可强制同步返回 |
| `timeout` | 1..600s | 90 | 单次请求超时（仅对网络/5xx 重试有效） |
| `retries` | 0..5 | 2 | 失败重试次数；指数退避 1s→2s→4s |
| `customHeaders` | object | — | 自定义请求头（JSON），键名仅字母/数字/`-` |
| `botName` | string≤40 | Acaily | 飞书侧 bot 显示名 |
| `systemPrompt` | string≤4000 | — | 默认系统提示词 |

环境变量：`ACAILY_MAX_RETRIES`（默认 2，覆盖用户级 `retries` 缺席时的网关默认）。

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
