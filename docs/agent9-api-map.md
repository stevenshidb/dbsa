# Agent9 能力 → 售前场景 → API 映射表

> API 契约以 agent9 仓库 `docs/openapi.yaml` 与 `src/chat/dto/request-bodies.dto.ts` 为准（本仓库 2026-08-20 快照）。

## 能力全景

| Agent9 能力 | 关键 API | 售前场景 | Demo 实现位置 | 前置条件 |
| --- | --- | --- | --- | --- |
| Agent 管理 | `POST /api/agents`、`GET /api/agents`、`PATCH /api/agents/:id/config` | 创建「TiDB 售前助手」角色；按团队/客户建不同 Agent | `scripts/seed.mjs`、`config/agent-tidb-presales.json` | 登录/API Key |
| 项目 | `GET /api/console/projects` | 确定工作区项目作用域（`x-agent9-project-id`） | `packages/client` | — |
| Session | `POST /api/sessions`、`GET /api/sessions/:id`、`POST /api/sessions/:id/agent` | 一客户一会话；切换 Agent | `apps/console` Chat 页 | — |
| Turn（流式） | `POST /api/sessions/:id/turns`（NDJSON） | 需求分析、方案问答、澄清提问 | `packages/client` NDJSON 解析、Console 流式渲染 | — |
| Turn 历史 | `GET /api/sessions/:id/turns`、`GET .../turns/:turnId` | 会话回放、Operation 审计 | Console Chat 页 | — |
| 记忆（Mem9） | Agent config `memory` + `POST /api/agents/memory/mem9/key-validations`、`PUT /api/agents/:id/memory/mem9/key` | 客户画像、历史偏好、决策记录 | `scripts/seed.mjs`（provision） | Mem9 凭据 |
| 会话召回 | Agent config `sessionRecall.enabled` | 跨会话回忆「这个客户上次聊过什么」 | seed 配置 | — |
| Artifact | `POST /api/artifacts/publish`、`GET /api/artifacts`、下载 | 方案书/报价单/标书版本化 | `scripts/demo.mjs`、Console 能力页 | Session Drive 内有文件 |
| User Files | `POST /api/user-files/uploads`（分片 presign） | 客户 RFP/招标文件上传 | 文档 + 预留接口 | 用户 API Key |
| 知识库 | `POST /api/console/workspace/kb-connections`、Agent config `knowledgeBase.enabled` | 案例库/FAQ/白皮书检索 | seed 配置 + Console 连接 | 外部 KB 凭据 |
| Web Search | Agent config 无开关（服务端 `EXA_API_KEY`）；工具 `web_search` | 竞品动态、行业资讯 | Console 场景预设「竞品对比」 | `EXA_API_KEY` |
| Scheduler | `POST /api/schedulers`、`GET /api/schedulers/:id/fires` | 每周客户跟进、投标倒计时 | `scripts/seed.mjs` | — |
| Reminder | Console 管理（`/api/console/reminders`） | 会议提醒 | 文档 | Cookie 会话 |
| Lark | `PATCH /api/agents/lark/capability`、工具 `lark_send_message` 等 | 飞书发跟进消息、建日程、查日历 | seed 配置 + 文档 | Lark 应用凭据 |
| Notion | `PUT /api/console/notion`（能力连接）、工具 `notion.page.create` 等 | 方案沉淀到团队知识库 | seed 配置 + 文档 | Notion PAT |
| Generated Media | Agent config `generatedMedia.enabled`、工具 `image_generate` | 方案封面、架构图配图 | seed 配置 | 媒体连接 |
| Skills | `POST /api/skills/ingestions`、`POST /api/agents/:id/skill-installations` | POC 手册/方案模板/竞品速查 | `config/skill-tidb-presales/SKILL.md`（待上传） | Skill 上传流程 |
| Managed Tools | `PUT /api/managed-tools/installations`、Agent config `tools.managed` | 接 CRM/商机系统（未来） | 预留配置位 | 包注册 + 沙箱 |
| Billing | `GET /api/workspace/users/:userId/billing/usage` | 每售前/客户成本看板 | `packages/client.getBillingUsage` | workspace key + `billing:read` |
| Console/观测 | `GET /api/console/sessions`、session-run-inspector | 会话/Operation/成本观测 | Console 能力页 | Cookie 会话 |

## 一次典型售前会话的 API 调用序列

```text
1. GET  /api/console/projects                     → 取 projectId
2. POST /api/sessions                             → 建客户会话（绑定售前 Agent）
3. POST /api/sessions/:id/turns                   → 需求分析（NDJSON 流：turn_started →
                                                     operation_step（记忆召回/KB 检索）→
                                                     assistant_draft → assistant_message）
4. POST /api/sessions/:id/turns                   → 追问/澄清（clarificationSourceTurnId）
5. （Agent 内部）                                  → memory.write（Mem9）异步入队
6. POST /api/artifacts/publish                    → 方案书发布（sourcePath=Drive 内文件）
7. POST /api/schedulers                           → 每周跟进定时任务
8. GET  /api/workspace/users/:userId/billing/usage→ 成本核对
```

## 角色设定（Agent9 无 system prompt 字段的应对）

Agent9 的 Agent 通过能力模块自动生成 system prompt，但不支持自定义 system prompt。Demo 采用：

1. **首轮注入**：会话第一轮用户消息前置角色简报（`config/prompts` 可扩展），后续轮次不带。
2. **Skill 注入**（正式）：把角色与工作流写成 `SKILL.md`，经 Skill 上传 → Agent 安装 → 每次 Run 自动加载指令。
