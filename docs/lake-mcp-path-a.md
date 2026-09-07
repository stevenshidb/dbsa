# TiDB Cloud Lake 数据源接入（MCP · 路径 A）

## 结论

Agent9（agent-stack）是 **MCP 客户端**，只消费远程 `streamable_http` 端点，不认识
`lake://` DSN。路径 A 的做法：在 tidbsa 里运行一个
**TiDB Cloud Lake → MCP HTTP 桥**，DSN 只留在桥的进程环境里，桥再以 Agent9
可访问的 HTTPS 端点注册为 MCP Server，激活后工具会出现在指定 Agent 的对话里。

官方 `tidbcloudlake-mcp` 需要 Python ≥3.12 并只负责“DB→MCP”这一段；Agent9 需要
远程 HTTPS 端点，部署端还要 TLS。因此本仓库提供零依赖 Node 桥
（`apps/lake-bridge`），按官方 LakeSQL 驱动协议实现
`/v1/session/login → /v1/query → /v1/session/refresh`，可以直接跑在任何有 Node ≥20
的机器上：

```text
TiDB Cloud Lake（你的账号/租户/warehouse）
      │ SQL over Lake REST API（/v1/query，session_token 优先）
      ▼
tidbsa apps/lake-bridge（pnpm lake:bridge）
      │ MCP JSON-RPC over Streamable HTTP（/mcp，Bearer 可选）
      ▼
TLS 反向代理（Nginx/Caddy/网关）
      │ https://lake-mcp.example.com/mcp
      ▼
Agent9：POST /api/mcp/servers（scope=agent）→ credential → activate
      ▼
Agent.config.tools.mcp = [{ serverId }] → 新对话可直接调用
```

参考：TiDB Cloud Lake MCP 文档
<https://docs.pingcap.com/tidbcloudlake/mcp-server/>；官方 server
<https://github.com/tidbcloud/lake-mcp>；连接协议来自官方驱动
<https://github.com/tidbcloud/lakesql>。

## 1. 启动本机桥

桥是零依赖 Node 服务，直接跑：

```bash
cd tidbsa
# 在 .env 填入 LAKE_DSN（lake://user:password@host:443/database?warehouse=warehouse）
# LAKE_MCP_SAFE_MODE=true 默认开启
pnpm lake:bridge
```

默认监听 `http://127.0.0.1:8002/mcp`，健康检查
`http://127.0.0.1:8002/healthz`。

常用环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LAKE_DSN` | - | 必填，桥连接 TiDB Cloud Lake 的 DSN |
| `LAKE_MCP_SAFE_MODE` | `true` | true = 只读 + sandbox 前缀写；false = 放开写 |
| `LAKE_BRIDGE_BEARER` | 空 | 对外暴露时建议设置；Agent9 侧配 static_bearer |
| `LAKE_MCP_BIND_HOST` | `127.0.0.1` | 内网联调保持回环；容器/公网可 `0.0.0.0` |
| `LAKE_MCP_BIND_PORT` | `8002` | HTTP 端口 |
| `LAKE_MCP_MAX_ROWS` | `200` | 返回给模型的最大行数，超出截断提示 |
| `LAKE_QUERY_TIMEOUT` | `300` | SQL 超时秒数 |

自测（不依赖真实 Lake 账号，模拟 login/refresh/query、token 过期自动续期）：

```bash
pnpm lake:selftest
```

## 2. 对 Agent9 暴露 HTTPS 端点

Agent9 注册接口只接受 `https://` 且不包含用户名密码的 URL。若 Agent9 与桥同内网，
可直接配 TLS 反代；staging/公网 Agent9 需要一个公网域名。Nginx 最小示例：

```nginx
server {
  listen 443 ssl;
  server_name lake-mcp.example.com;
  # ssl_certificate / ssl_certificate_key ...
  location /mcp {
    proxy_pass http://127.0.0.1:8002;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

## 3. 注册到 Agent9 并挂载

一行命令（自动完成 注册 → 绑定凭据 → 激活 → 写入 Agent.tools.mcp）：

```bash
pnpm cli mcp lake connect https://lake-mcp.example.com/mcp \
  --agent <售前AgentId> \
  --bearer <桥Bearer，可选>
```

也可以在 Web 控制台「专家·连接器 → 🔗 连接器」：

1. 在 **TiDB Cloud Lake（MCP 数据源）** 卡片粘贴 Lake MCP 地址，可选填访问密钥；
2. 选择要挂载的 Agent；
3. 点「一键注册 · 激活 · 挂载」；
4. 下方「MCP 服务器」列表刷新后出现该注册，状态为已激活。

激活成功后，Agent 对话会多出与官方 lake-mcp 一致的工具：

| 工具 | 用途 |
| --- | --- |
| `execute_sql` / `execute_multi_sql` | 执行 SQL（安全模式下只读） |
| `show_databases` / `show_tables` / `show_functions` | 元数据浏览 |
| `describe_table` | 查看表结构 |
| `show_stages` / `list_stage_files` / `create_stage` | Stage / 连接浏览与 sandbox 写 |
| `show_connections` | 连接浏览 |
| `get_session_sandbox_prefix` 等 | sandbox 会话工具 |

## 4. 安全边界

- **DSN 密码只存在于桥进程**：Agent9 Secret Store 只保存访问桥的 Bearer，Lake
  账号不出内网；桥优先使用官方 login 的 `session_token`，不在每次查询重复使用
  明文 Basic，token 过期自动 refresh；
- **默认 Safe Mode ON**：`SELECT/SHOW/DESCRIBE/EXPLAIN/LIST` 放行，写操作只放行
  `mcp_sandbox_<session>_*` 前缀对象；`LAKE_MCP_SAFE_MODE=false` 才放开写；
- **桥建议加 Bearer**（Agent9 支持 `static_bearer`），并对公网端点做 allowlist / mTLS；
- Agent9 侧还有出口策略、Operation 审计与结果文本投影，形成第二道边界；
- Lake 侧账号权限应继续收窄到所需库（数据库权限是最后一道防线）。

## 5. 已知限制与故障排查

- Agent9 当前 MCP 结果只消费 **text/link**，桥统一把 SQL 结果格式化为 text JSON；
- 若 Agent9 激活报连不上或 Internal Server Error：Agent9 注册与激活的**探测来自
  Agent9 服务端所在网络**，因此 MCP 地址必须是它可达的公网 HTTPS 地址，不能填
  `127.0.0.1`、`localhost` 或内网 IP（否则 Agent9 会连自己容器内的回环地址并返回
  500）。本机桥需要套 TLS 反代或临时公网隧道后再填地址；
- `curl https://你的域名/mcp -X POST ...` 能返回 JSON 后再注册；
- 桥内置的 Lake 协议测试（`pnpm lake:selftest`）不依赖真实账号；首次对真实
  Lake 联调若返回鉴权错误，请确认 DSN 的 host/数据库/warehouse 与 TiDB Cloud
  Lake 控制台连接信息一致，并检查网络到 `:443` 是否可达；
- 若你的 Lake 端点不支持 `/v1/session/login`（返回 404/405），桥会自动降级为
  Basic Auth 直连，不需要额外配置。
