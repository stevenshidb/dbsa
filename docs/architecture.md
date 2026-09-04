# TiDB 售前 Agent —— 整体架构规划

## 1. 产品定位

**TiDB 售前 Agent（tidbsa）** 是面向 TiDB 售前工程师的 AI 售前工作台：

- 让售前工程师在**一个入口**完成：客户需求分析、方案设计、竞品应对、POC 准备、方案书/标书生成、会议纪要与跟进。
- 沉淀团队知识：案例库、FAQ、白皮书、竞品速查、POC 手册通过 Agent9 的 Knowledge Base / Skill / Memory 能力统一接入。
- 让售前经理可管理：客户会话、产出物、成本、使用量全部在 Agent9 的可观测与计费体系内。

## 2. 目标用户

| 用户 | 场景 | 形态 |
| --- | --- | --- |
| 售前工程师 | 日常售前工作 | Web Console（主）+ CLI（脚本） |
| 售前经理 | 会话/产出物/成本管理、模板复用 | Web Console 管理视图 |
| 销售 | 轻量技术问答、竞品速查 | 飞书机器人（Lark 能力） |

## 3. 总体架构

```text
用户层
  Web Console（本仓库 apps/console）  CLI（本仓库 cli）  飞书（Lark）  未来：企微/钉钉
        │                                 │                  │
        └──────────────┬──────────────────┴──────────────────┘
                       ▼
入口层  tidbsa 客户端（packages/client，封装 Agent9 REST + NDJSON 流）
                       │  Bearer API Key + x-agent9-project-id
                       ▼
能力层  Agent9（控制平面）
  ├── Agent API        —— 售前助手角色配置（模型/记忆/工具/沙箱）
  ├── Session/Turn API —— 每个客户一个会话，流式对话
  ├── Memory API       —— Mem9 客户记忆（recall/write）
  ├── Artifact API     —— 方案书/报价单/标书（版本化 + 下载）
  ├── User Files API   —— 客户 RFP/招标文件上传
  ├── KB API           —— 案例库/FAQ/白皮书检索
  ├── Scheduler/Reminder —— 客户跟进、会议提醒
  ├── Web Search       —— 竞品动态、行业资讯
  ├── Lark / Notion    —— 发送消息、建日程、沉淀文档
  ├── Generated Media  —— 方案封面/架构图配图
  ├── Skills           —— 售前技能包（POC 手册/方案模板/竞品速查）
  ├── Managed Tools    —— 未来接 CRM/商机系统
  └── Billing / Console —— 用量、成本、观测
                       │
                       ▼
内容与数据层
  TiDB 知识库（案例/FAQ/白皮书/架构图）  Mem9（客户记忆）  Drive9（方案文件）
  Agent9 主库 TiDB（会话/审计/计费）      TiDB Cloud Lake（分析，演进项）
```

## 4. 售前全流程 × 能力覆盖

```text
商机发现      需求分析       方案设计        POC          竞标          交付/跟进
  │             │             │             │             │              │
  ├─ WebSearch   ├─ Session    ├─ KB 检索      ├─ Sandbox     ├─ Artifact    ├─ Scheduler
  ├─ KB 案例库   ├─ Memory     ├─ Artifact     ├─ Exec        ├─ User Files  ├─ Reminder
  └─ Lark 提醒   ├─ 澄清提问    ├─ Generated    ├─ Artifact    ├─ Memory      ├─ Lark 消息
                 └─ Notion     │  Media        └─ Skill       ├─ KB          └─ Notion 沉淀
                               └─ Skill 模板                  └─ Session Recall
```

## 5. Demo（本仓库）范围

### 已实现

- `packages/client`：Agent9 核心 API 客户端（Agent/Session/Turn 流/Artifact/Scheduler/Billing）。
- `apps/console`：Web Demo，含 **Mock 模式**（无后端可演示交互）与 **Live 模式**（连真实 Agent9）。
- `cli` + `scripts/seed.mjs` + `scripts/demo.mjs`：一键初始化与脚本化演示。
- `config/agent-tidb-presales.json`：全能力 Agent 配置模板（记忆/会话召回/知识库/媒体/Notion/沙箱）。
- `config/skill-tidb-presales/SKILL.md`：售前技能包内容（POC 清单/方案结构/竞品速查/异议处理）。

### 依赖外部凭证、Demo 中留接口的能力

| 能力 | Demo 中的处理 |
| --- | --- |
| Mem9 记忆写 | Agent 配置启用 + `memoryCredential.provision`；无凭据时降级为不绑定 |
| 知识库（Volcengine/Deotaland） | Console 中配置连接；Agent 已默认启用 KB 意图 |
| Lark / Notion / Generated Media | Agent 配置启用；连接在 Agent9 Console 完成 |
| Managed Tools | 预留 `tools.managed` 配置位；接 CRM 时安装包即可 |
| Billing 用量 | 客户端提供 `getBillingUsage`；需要 workspace key 的 `billing:read` 权限 |

## 6. 演进路线

### Phase 1：Demo 验证（本仓库）

- 目标：让售前团队看到「一个入口做完售前全流程」。
- 验收：Mock 模式演示 + 一个真实 Agent9 实例上的 Live 会话。

### Phase 2：试点（1 个售前团队）

- 接入真实知识库（案例/FAQ/白皮书）、Mem9 记忆、Lark 机器人。
- 用 Agent9 Skill 机制固化 3 个技能包：POC 手册、方案模板、竞品速查。
- 用 Scheduler 建立「每周客户跟进」；用 Billing API 做团队用量看板。
- 需要：Agent9 生产部署（参考 agent9 仓库 deploy/）、各外部服务凭据。

### Phase 3：全员推广

- Web Console 升级为正式产品（登录、团队、模板市场）。
- 每个售前一个 Agent 实例 + 每客户一个 Session 的规范。
- 沉淀「售前知识库」治理流程：案例入库评审、白皮书版本管理。

## 7. 关键设计决策

1. **会话模型：一客户一会话**。Agent9 Session 天然支持 `session_agents` 链接与 `session_users` 协作，客户维度用 Session 名称与 Session Recall 关联。
2. **记忆模型：一客户一记忆空间**。Agent9 的 Mem9 key 归属 Agent；若每个售前一个 Agent，则记忆按售前划分；若后续按客户划分，需要在 Agent9 上扩展（见 agent9 报告 24 节记忆网关方向）。
3. **角色注入：首轮简报 + Skill**。Agent9 的 `CreateAgentBody` 没有 system prompt 字段，Demo 用首轮用户消息携带角色设定；正式版用 Skill 包（`SKILL.md` 指令随 Run 加载）承载角色与工作流。
4. **知识优先于模型**。售前问答质量取决于知识库质量，Demo 把「案例/FAQ/白皮书」列为试点第一优先建设项。
5. **成本可控**。Billing 是 Agent9 内建能力，试点即要求每售前/每客户成本可见。

## 8. 风险与依赖

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Agent9 单实例部署 | 无法水平扩展 | 试点规模足够；演进期按 agent9 报告 17 节改造 |
| 外部服务凭据（Mem9/Drive9/E2B） | Demo 部分能力不可用 | Mock 模式 + 渐进接入 |
| 知识库内容建设 | 问答质量受限 | 试点期以「案例+FAQ」最小集起步 |
| 模型幻觉 | 售前方案可信度 | 用 KB 引用 + 澄清机制；人工复核方案书 |
