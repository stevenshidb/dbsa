import { useEffect, useState } from 'react';
import { connectExternalMcp, mcpEndpointIssue } from './mcp-connect';

const friendly = (err) => err?.message ?? String(err);
const DISPLAY_NAME = 'TiDB Cloud Essential';
const ESSENTIAL_LOCAL_HINT =
  '请先在公网服务器上运行官方 TiDB MCP Server（--transport streamable-http），再经域名 + TLS 暴露成 https://…/mcp 后填写。';

const DEPLOY_EXAMPLE = `export TIDB_HOST='gateway01.<region>.prod.aws.tidbcloud.com'
export TIDB_PORT='4000'
export TIDB_USERNAME='<实例前缀>.root'   # 2026-07 后新实例按控制台连接弹窗填写
export TIDB_PASSWORD='<你的密码>'
export TIDB_DATABASE='test'

# Python >= 3.10 且已安装 uv；端点 = https://你的域名/mcp
uvx --from 'pytidb[mcp]' tidb-mcp-server \\
  --transport streamable-http --host 0.0.0.0 --port 8000`;

export default function EssentialConnector({
  client,
  live,
  agents,
  selectedAgentId,
  onNotice,
  onChanged,
}) {
  const [form, setForm] = useState({ endpointUrl: '', bearer: '', agentId: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setForm((p) => ({ ...p, agentId: selectedAgentId || agents[0]?.agentId || '' }));
  }, [selectedAgentId, agents]);

  const connect = async () => {
    const endpointUrl = form.endpointUrl.trim();
    const agentId = form.agentId;
    if (!live) {
      onNotice?.('Mock 模式：一键连接将在 Live 模式下执行');
      return;
    }
    const issue = mcpEndpointIssue(endpointUrl, ESSENTIAL_LOCAL_HINT);
    if (issue) {
      onNotice?.(issue);
      return;
    }
    if (!agentId) return onNotice?.('请先选择要挂载的 Agent');

    setBusy(true);
    try {
      const { steps } = await connectExternalMcp({
        client,
        endpointUrl,
        bearer: form.bearer,
        agentId,
        displayName: DISPLAY_NAME,
      });
      onNotice?.(`TiDB Cloud Essential（MySQL/MCP）连接成功：\n${steps.join('\n')}`);
      onChanged?.();
    } catch (err) {
      const message = friendly(err);
      const hint = /Internal Server Error|HTTP 500|http_500/i.test(message)
        ? '\n提示：500 通常是 Agent9 云无法连通你填写的端点。请确认：1) 地址是公网可达的 https://…/mcp，不是 127.0.0.1/localhost/内网 IP；2) 服务端已用官方 pytidb[mcp] 以 --transport streamable-http 启动；3) 端点若设了 Bearer，访问密钥要填写一致。'
        : /credential.*(missing|stale)|missing or stale/i.test(message)
          ? '\n提示：凭据状态仍未匹配。可先在下方 MCP 服务器列表中停用/删除后重试，或核对端点要求无鉴权还是有 Bearer。'
          : '';
      onNotice?.(`连接 TiDB Cloud Essential 失败：${message}${hint}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connector-card">
      <div className="card-title">
        <strong>TiDB Cloud Essential（MySQL/MCP）</strong>
        <span className="tag tag-live">{live ? 'Live' : 'Mock'}</span>
      </div>
      <p className="hint">
        Essential 是 MySQL 兼容实例，由官方 TiDB MCP Server（pytidb）暴露为远程
        streamable HTTP 端点。填入 Agent9 能访问到的公网 https://…/mcp（不能填
        127.0.0.1/localhost/内网 IP），可选 Bearer，一键注册、激活并挂载到 Agent，
        之后即可自然语言查库（show_databases / db_query / db_execute 等）。
      </p>
      <details className="conn-deploy">
        <summary>还没有 MCP 地址？查看启动与部署示例</summary>
        <p className="hint">
          先在公网 Linux 服务器用 Essential 控制台里的连接参数启动（需要 Python ≥ 3.10
          与 uv；连接参数以控制台 Connect 弹窗为准）：
        </p>
        <pre>{DEPLOY_EXAMPLE}</pre>
        <p className="hint">
          再把 8000 端口经 Nginx/Caddy 套一层 HTTPS，得到的地址填入上方表单。
        </p>
      </details>
      <div className="conn-form">
        <label>Essential MCP 地址（https://…/mcp）
          <input
            value={form.endpointUrl}
            placeholder="https://essential-mcp.example.com/mcp"
            onChange={(e) => setForm({ ...form, endpointUrl: e.target.value })}
          />
        </label>
        <label>访问密钥 / Bearer（可选）
          <input
            type="password"
            value={form.bearer}
            placeholder="无鉴权可留空"
            onChange={(e) => setForm({ ...form, bearer: e.target.value })}
          />
        </label>
        <label>挂载到 Agent
          <select value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}>
            <option value="">选择 Agent…</option>
            {agents.map((a) => (
              <option key={a.agentId} value={a.agentId}>
                {a.name ?? a.agentId}
              </option>
            ))}
          </select>
        </label>
        <div className="actions">
          <button className="primary" disabled={busy} onClick={connect}>
            {busy ? '连接中…' : '连接并挂载到 Agent'}
          </button>
        </div>
      </div>
      {!form.agentId && <p className="hint">请在上方选择要挂载的 Agent。</p>}
    </div>
  );
}
