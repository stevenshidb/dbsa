# tidbsa —— TiDB 售前 Agent（基于 Agent9 开发）

面向 TiDB 售前工程师的 AI 售前工作台 Demo。项目建立在 Agent9 的开放 API 之上，把 Agent9 现有能力（Agent / Session / Turn / Memory / Artifact / KB / Scheduler / Web Search / Lark / Notion / Generated Media / Billing）映射到售前全流程场景。

## 快速开始

```bash
cd tidbsa
pnpm install
pnpm console          # 启动 Web Demo（无后端时自动进入 Mock 模式）
```

连接真实 Agent9 实例（Live 模式）：

```bash
cp .env.example .env
# 填入 AGENT9_BASE_URL / AGENT9_API_KEY / AGENT9_PROJECT_ID
pnpm seed             # 一键创建「TiDB 售前助手」Agent + 会话 + 定时任务
pnpm demo             # 跑一遍脚本化售前流程（需求分析 → 方案生成 → 制品列表）
pnpm cli chat "客户想从 MySQL 迁移到 TiDB，帮我梳理 POC 方案"   # 命令行问答
pnpm lake:bridge      # 启动 TiDB Cloud Lake MCP 桥（路径 A，先填 .env 的 LAKE_DSN）
```

## 目录

```text
tidbsa/
├── docs/
│   ├── architecture.md      # 整体架构规划（产品/技术/演进）
│   └── agent9-api-map.md    # Agent9 能力 → 售前场景 → API 映射表
├── packages/client/         # Agent9 API 客户端（零依赖 ESM，Web/CLI 共用）
├── apps/console/            # Web Demo（Vite + React，含 Mock 模式）
├── apps/lake-bridge/        # TiDB Cloud Lake → MCP(streamable HTTP) 桥（零依赖 Node）
├── cli/                     # 命令行 Demo
├── config/
│   ├── agent-tidb-presales.json   # Agent 全能力配置模板
│   └── skill-tidb-presales/SKILL.md  # 售前技能包（POC/方案/竞品速查）
├── scripts/
│   ├── seed.mjs             # 一键初始化
│   └── demo.mjs             # 脚本化演示流程
└── docker-compose.yml       # 本地全栈（TiDB + Agent9）可选
```

## 演示方式

| 模式 | 说明 | 前置条件 |
| --- | --- | --- |
| Mock | 前端内置模拟会话流，展示产品交互 | 无 |
| Live | 真实调用 Agent9 API | 已部署的 Agent9 + API Key |
| 全栈本地 | docker compose 起 TiDB + Agent9（Linux/amd64） | Docker（Apple Silicon 较慢） |

当前接入环境：**staging Agent9**（`https://us-west-2.staging.agent.mem9.ai`）。

详细规划见 [docs/architecture.md](docs/architecture.md)，能力映射见 [docs/agent9-api-map.md](docs/agent9-api-map.md)。

## 功能

- **多 Agent 对话**：顶栏切换 Agent（每个 Agent 的会话相互独立，本地记录）；左侧会话列表可回到历史会话。
- **对话框附件**：点击 📎 附加文件（最多 3 个），自动计算 SHA-256 并经 Agent9 用户文件接口上传校验，随 Turn 带给模型。
- **Agent 管理**：「Agent 管理」页支持列表查看、创建、重命名、归档（删除）。
- **Skill 上传**：「Skills」页上传 SKILL ZIP（需 YAML frontmatter，见 `config/skill-tidb-presales/SKILL.md`），自动确认后安装到当前 Agent。
- **语音输入**：聊天框底部「🎤 语音」开启中文连续识别（Chrome/Edge，需麦克风权限），边说边转文字，确认后回车或点发送即可与 Agent 对话。
- **客户档案 · Drive 工作区（P0）**：每个“项目/文件夹”可打开为客户档案页，维护客户元数据；页面聚合该客户所有会话、自动归档会话内 Drive 文件（预览/搜索/下载），并可一键把资料文件上传后交给 Agent 阅读分析。
- **专家记忆 · 知识源（P1.5）**：专家详情页可查看/开关 Agent 的 Mem9 客户记忆、会话召回、团队 KB 与 Notion，并支持绑定/轮换 Mem9 Key；回答引用记忆或团队资料时，消息下方会显示可追溯来源。
- **TiDB Cloud Lake 数据源（MCP）**：`apps/lake-bridge` 用 `lake://` DSN 连接
  TiDB Cloud Lake（官方 LakeSQL REST 协议：login → /v1/query → refresh，零 Python
  依赖），同样提供 streamable HTTP MCP 端点；在「专家·连接器 → 连接器」一键
  注册/激活/挂载到 Agent。详细步骤见 [docs/lake-mcp-path-a.md](docs/lake-mcp-path-a.md)。
- **TiDB Cloud Essential（MySQL/MCP）连接器**：Essential 是 MySQL 兼容实例，
  通过官方 TiDB MCP Server（`pytidb[mcp]`，streamable HTTP）暴露为远程端点；
  在「专家·连接器 → 连接器」的 Essential 卡片里粘贴
  `https://…/mcp` 即可一键注册/激活/挂载到 Agent。

## 常见问题

### 1) `pnpm seed` / `pnpm cli` 报 fetch failed

说明 Node 连不上 Agent9。先跑诊断：

```bash
pnpm cli doctor
```

常见原因：

- Agent9 服务未启动（docker compose 请确认 `migrate` 成功、`agent9` 容器 healthy）。
- `AGENT9_BASE_URL` 填错（本地 docker compose 为 `http://localhost:5172`）。
- Apple Silicon 上 docker compose 的 agent9 是 amd64 模拟，启动很慢，等待 `/livez` 200 后再试。

### 2) Console 创建 Agent 报 Internal Server Error

- 若 Base URL 留空：请求经 Vite 代理转发到 `localhost:5172`，Agent9 不在那里时代理会返回 500。请确认服务已启动，或在「设置」中填写正确地址。
- 若地址正确仍 500：先 `pnpm cli doctor` 看服务端状态；Agent9 的 `POST /api/agents` 要求 `Idempotency-Key` 头（客户端已自动携带），服务端 500 多为未配置模型 Provider（`model_provider_unconfigured` 需 LLM 密钥）或工作区缺少默认模板。

### 3) 端口冲突

Console 固定 5272；Agent9 固定 5172。两者不同端口，不会冲突。

### 4) 激活 Lake MCP 报 Internal Server Error 或 credential stale

- 500 的常见原因：MCP 地址填成了 `https://127.0.0.1:8002/mcp`、`localhost` 或内网
  IP。云端 Agent9 只能访问公网地址，这类地址会连到 Agent9 自己容器内的回环并返回
  500。请把 `pnpm lake:bridge` 暴露成公网 HTTPS（域名 + TLS，或临时隧道）后填写
  `https://你的域名/mcp`；
- 早期误填的 127.0.0.1 注册会在再次连接公网地址时被自动迁移，无需手动清理；
- `credential is missing or stale` 表示注册状态版本已变化：新版已改为绑定凭据后重读
  最新版本再激活；若仍出现，可先在「连接器 → MCP 服务器」里停用再重连。
