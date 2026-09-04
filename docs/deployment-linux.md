# Linux 服务器部署记录（历史，已停用）

> **状态：已停用（2026-08-21）。** 本页记录一次完整的 Linux 部署演练（`16.162.21.58`），不再作为当前环境。
> 当前接入的是 staging Agent9：`https://us-west-2.staging.agent.mem9.ai`。
> 若未来需要自建环境，以下流程仍可作为参考。

## 当时的环境信息

| 项 | 值 |
| --- | --- |
| 服务器 | `16.162.21.58`（AWS ap-east-1，Amazon Linux 2023，x86_64）—— 已停用 |
| Agent9 | `/opt/agent9`，systemd 服务 `agent9`，监听 `0.0.0.0:5172` |
| TiDB | Docker 容器 `tidb`（`pingcap/tidb:v8.5.1`），数据库 `agent9` |
| Node / pnpm | Node 22.23.1、pnpm 11.9.0 |
| 运行配置 | `/etc/agent9.env`（NODE_ENV=development，开发账号模式） |

## 常用运维命令（历史参考）

```bash
sudo systemctl status agent9        # 服务状态
sudo journalctl -u agent9 -f        # 实时日志
sudo systemctl restart agent9       # 重启
curl http://127.0.0.1:5172/livez
sudo docker logs --tail 50 tidb     # TiDB 日志
mysql -h127.0.0.1 -P4000 -uroot agent9 -e "SHOW TABLES" | wc -l
```

## 更新 Agent9 代码（历史参考）

```bash
# 本机打包并上传
cd /Users/shidb/Desktop/code/dsh/agent
tar czf /tmp/agent9-src.tar.gz --exclude='agent9/.git' --exclude='agent9/node_modules' \
  --exclude='agent9/dist' --exclude='agent9/apps/console/dist' \
  --exclude='agent9/apps/console/node_modules' -C . agent9
cat /tmp/agent9-src.tar.gz | ssh -i agentstack.pem ec2-user@<HOST> \
  'sudo tar xzf - -C /opt && sudo chown -R ec2-user:ec2-user /opt/agent9'

# 服务器上构建 + 迁移 + 重启
ssh -i agentstack.pem ec2-user@<HOST> \
  'cd /opt/agent9 && pnpm install --frozen-lockfile && pnpm build && pnpm console:build \
   && DATABASE_URL="mysql://root@127.0.0.1:4000/agent9" TIDB_SSL=off pnpm migrate:deploy \
   && sudo systemctl restart agent9'
```

## 配置真实能力（通用，仍适用于新环境）

编辑 `/etc/agent9.env` 后重启服务：

```bash
# 真实 LLM 回复（任选一组）：
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_API_MODE=chat_completions
OPENAI_MODEL=DeepSeek-V4-Flash
# 或 Claude：
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_API_KEY=sk-ant-...
# 记忆（Mem9）：
MEM9_API_URL=https://api.mem9.ai
MEM9_ADMIN_API_URL=https://console-api.mem9.ai
# Web 搜索：
EXA_API_KEY=exa-...
```

### DeepSeek 模型名补丁（重新部署时必须带上）

DeepSeek 官方 API 只接受小写模型名 `deepseek-v4-flash`，而 Agent9 注册表名为 `DeepSeek-V4-Flash`。已在
`src/runtime/pi-agent-runtime.adapter.ts` 的 `trackedStreamFn` 中加 `onPayload` 改写（仅改写发出请求的模型名字段）。
从上游同步代码或重建镜像前，请确认该补丁仍在，否则 DeepSeek 请求会 400。

## 安全提示

演示环境请使用 `NODE_ENV=development` + `ENABLE_DEV_ACCOUNT=1` 时注意：任何能访问服务端口的人都等于免密使用 API。
正式使用必须改为生产模式（真实登录/API Key、HTTPS、关闭开发账号），并把安全组限制到公司 IP。
