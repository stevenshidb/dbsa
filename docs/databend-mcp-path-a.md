# Databend 数据源接入（MCP · 路径 A）

## 结论

Agent9（agent-stack）是 **MCP 客户端**，只消费远程 `streamable_http` 端点，不认识
`databend://` DSN。路径 A 的做法是：在 tidbsa 里运行一个 **Databend → MCP HTTP 桥**，
DSN 只留在桥的进程环境里，桥再以 Agent9 可访问的 HTTPS 端点注册为 MCP Server，
激活后工具会出现在指定 Agent 的对话里。

```text
Databend（你的账号/租户）
      │ SQL over Databend HTTP Handler（/v1/query/）
      ▼
tidbsa apps/databend-bridge（pnpm databend:bridge）
      │ MCP JSON-RPC over Streamable HTTP（/mcp，Bearer 可选）
      ▼
TLS 反向代理（Nginx/Caddy/网关）
      │ https://databend-mcp.example.com/mcp
      ▼
Agent9：POST /api/mcp/servers（scope=agent）→ credential → activate
      ▼
Agent.config.tools.mcp = [{ serverId }] → 新对话可直接调用
```

## 1. 启动本机桥

桥是零依赖 Node 服务，直接跑：

```bash
cd tidbsa
# 在 .env 填入 DATABEND_DSN（databend://user:password@host:443/default?warehouse=default）
# DATABEND_MCP_SAFE_MODE=true 默认开启
pnpm databend:bridge
```

默认监听 `http://127.0.0.1:8001/mcp`，健康检查
`http://127.0.0.1:8001/healthz`。

常用环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATABEND_DSN` | - | 必填，桥连接 Databend 的 DSN |
| `DATABEND_MCP_SAFE_MODE` | `true` | true = 只读 + sandbox 前缀写；false = 放开写 |
| `DATABEND_BRIDGE_BEARER` | 空 | 对外暴露时建议设置；Agent9 侧配 static_bearer |
| `DATABEND_MCP_BIND_HOST` | `127.0.0.1` | 内网联调保持回环；容器/公网可 `0.0.0.0` |
| `DATABEND_MCP_BIND_PORT` | `8001` | HTTP 端口 |
| `DATABEND_MCP_MAX_ROWS` | `200` | 返回给模型的最大行数，超出截断提示 |
| `DATABEND_QUERY_TIMEOUT` | `300` | SQL 超时秒数 |

自测（不依赖真实 Databend）：

```bash
pnpm databend:selftest
```

## 2. 对 Agent9 暴露 HTTPS 端点

Agent9 注册接口只接受 `https://` 且不包含用户名密码的 URL。若 Agent9 与桥同内网，可直接配
TLS 反代；staging/公网 Agent9 需要一个公网域名。Nginx 最小示例：

```nginx
server {
  listen 443 ssl;
  server_name databend-mcp.example.com;
  # ssl_certificate / ssl_certificate_key ...
  location /mcp {
    proxy_pass http://127.0.0.1:8001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

## 3. 注册到 Agent9 并挂载

一行命令（自动完成 注册 → 绑定凭据 → 激活 → 写入 Agent.tools.mcp）：

```bash
pnpm cli mcp databend connect https://databend-mcp.example.com/mcp \
  --agent <售前AgentId> \
  --bearer <桥Bearer，可选>
```

也可以在 Web 控制台「专家·连接器 → 🔗 连接器」：

1. 在顶部 **Databend 数据源（MCP 路径 A）** 卡片填端点与 Bearer；
2. 选择要挂载的 Agent；
3. 点「一键注册 · 激活 · 挂载」；
4. 下方「MCP 服务器」列表刷新后出现该注册，状态为已激活。

激活成功后，Agent 对话会多出以下工具：

| 工具 | 用途 |
| --- | --- |
| `execute_sql` / `execute_multi_sql` | 执行 SQL（安全模式下只读） |
| `show_databases` / `show_tables` / `show_functions` | 元数据浏览 |
| `describe_table` | 查看表结构 |
| `show_stages` / `list_stage_files` / `show_connections` | Stage / 连接浏览 |
| `get_session_sandbox_prefix` 等 | sandbox 会话工具 |

## 4. 安全边界

- **DSN 密码只存在于桥进程**：Agent9 Secret Store 只保存访问桥的 Bearer，Databend 账号不出内网；
- **默认 Safe Mode ON**：`SELECT/SHOW/DESCRIBE/EXPLAIN/LIST` 放行，写操作只放行
  `mcp_sandbox_<session>_*` 前缀对象；`DATABEND_MCP_SAFE_MODE=false` 才放开写；
- **桥建议加 Bearer**（Agent9 支持 `static_bearer`），并对公网端点做 allowlist / mTLS；
- Agent9 侧还有出口策略、Operation 审计与结果文本投影，形成第二道边界。

## 5. 已知限制与故障排查

- Agent9 当前 MCP 结果只消费 **text/link**，桥统一把 SQL 结果格式化为 text JSON；
- 若 Agent9 激活报连不上：桥要在 Agent9 网络可达处。注意 Agent9 注册接口强制要求
  `https://`，本地全栈也要在桥前面套 TLS 反代，不能用裸 `http://localhost:8001`；
- `curl https://你的域名/mcp -X POST ...` 能返回 JSON 后再注册；
- 真实 Databend 账号欠费/被禁用会返回 `402 BadTenant: Tenant disabled`，需要先恢复租户；
- Databend Cloud 若只提供 OAuth 托管 MCP 端点，Agent9 无法做 OAuth 登录流；本桥用
  DSN 用户名密码走 HTTP Handler，因此可绕过该限制（请把账号权限收窄到所需库）。
