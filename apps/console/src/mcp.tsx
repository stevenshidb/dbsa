import { useEffect, useState } from 'react';
import { mcpEndpointIssue } from './lake';

const friendly = (err) => err?.message ?? String(err);

const MOCK_SERVERS = [
  {
    serverId: 'mcp_mock_1',
    scope: { kind: 'workspace', id: 'tenant_dev' },
    displayName: '内部知识库 MCP',
    endpointUrl: 'https://kb.internal.example/mcp',
    endpointVersion: 1,
    transport: 'streamable_http',
    status: 'active',
    serverVersion: 2,
    observation: { era: 'modern', protocolVersion: '2025-06-18', endpointVersion: 1, credentialBindingId: 'mcpcred_mock', credentialVersion: 1, probedAt: new Date().toISOString(), expiresAt: '' },
  },
  {
    serverId: 'mcp_mock_2',
    scope: { kind: 'agent', id: 'agent_presales_expert' },
    displayName: 'TiDB Cloud MCP',
    endpointUrl: 'https://api.mcp.example/mcp',
    endpointVersion: 1,
    transport: 'streamable_http',
    status: 'inactive',
    serverVersion: 1,
    observation: null,
  },
];

export function McpSection({ client, live, agents, onNotice, refreshToken = 0 }) {
  const [servers, setServers] = useState([]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ displayName: '', endpointUrl: '', scopeKind: 'workspace', agentId: '' });
  const [cred, setCred] = useState({}); // serverId -> { authKind, secret, currentVersion }
  const [credOpen, setCredOpen] = useState(null);

  const load = async () => {
    if (!live) {
      setServers(MOCK_SERVERS);
      return;
    }
    try {
      const res = await client.listMcpServers();
      setServers(res?.servers ?? res ?? []);
      setNotice('');
    } catch (err) {
      setNotice(`加载 MCP 服务器失败：${friendly(err)}`);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, refreshToken]);

  const act = async (label, fn) => {
    setBusy(true);
    try {
      await fn();
      setNotice(`${label}成功`);
      await load();
    } catch (err) {
      setNotice(`${label}失败：${friendly(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const register = () => {
    const endpointIssue = mcpEndpointIssue(form.endpointUrl.trim());
    if (!form.displayName.trim()) return setNotice('请填写名称');
    if (endpointIssue) return setNotice(endpointIssue);
    const scope =
      form.scopeKind === 'agent'
        ? { kind: 'agent', agentId: form.agentId }
        : { kind: form.scopeKind };
    act('注册', async () => {
      if (live) {
        await client.createMcpServer({ displayName: form.displayName.trim(), endpointUrl: form.endpointUrl.trim(), scope });
      }
      setForm({ displayName: '', endpointUrl: '', scopeKind: 'workspace', agentId: '' });
    });
  };

  const toggleActive = (s) =>
    act(s.status === 'active' ? '停用' : '激活', async () => {
      if (!live) return;
      if (s.status === 'active') {
        await client.deactivateMcpServer(s.serverId, s.serverVersion);
      } else {
        await client.activateMcpServer(s.serverId, s.serverVersion);
      }
    });

  const saveCredential = (s) => {
    const c = cred[s.serverId] ?? {};
    act('保存凭据', async () => {
      if (live) {
        if (c.authKind === 'static_bearer') {
          if (!c.secret) throw new Error('请输入凭据值');
          await client.putMcpCredential(s.serverId, { authKind: 'static_bearer', secret: c.secret });
        } else {
          await client.putMcpCredential(s.serverId, { authKind: 'none' });
        }
      }
      setCred((p) => ({ ...p, [s.serverId]: { ...c, secret: '' } }));
      setCredOpen(null);
    });
  };

  const rotate = (s) => {
    const c = cred[s.serverId] ?? {};
    act('轮换凭据', async () => {
      if (!c.secret) throw new Error('请输入新密钥后轮换');
      if (live) {
        await client.rotateMcpCredential(s.serverId, {
          expectedCurrentVersion: c.currentVersion ?? 0,
          secret: c.secret,
        });
        const res = await client.getMcpCredential(s.serverId);
        const next = res?.credential ?? res ?? {};
        setCred((p) => ({
          ...p,
          [s.serverId]: { authKind: next.authKind ?? c.authKind, secret: '', currentVersion: next.currentVersion ?? 0, active: next.active },
        }));
      }
    });
  };

  const loadCred = async (s) => {
    if (!live) return;
    try {
      const res = await client.getMcpCredential(s.serverId);
      const c = res?.credential ?? res ?? {};
      setCred((p) => ({ ...p, [s.serverId]: { authKind: c.authKind ?? 'none', secret: '', currentVersion: c.currentVersion ?? 0, active: c.active } }));
    } catch (err) {
      setNotice(`读取凭据失败：${friendly(err)}`);
    }
  };

  const scopeName = (s) =>
    s.scope?.kind === 'agent' ? `Agent ${s.scope.id}` : s.scope?.kind ?? s.scope?.id ?? '-';

  return (
    <div className="connectors">
      {notice && <div className="notice">{notice}</div>}
      <div className="connector-card">
        <div className="card-title">
          <strong>MCP 服务器（远程工具）</strong>
          <span className="tag tag-live">{servers.length} 个</span>
        </div>
        <p className="hint">
          注册外部 MCP Server（streamable_http），激活后其工具即可被 Agent 调用；凭据统一存 Secret Store。
        </p>
        <div className="skill-form">
          <input placeholder="显示名称" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          <input placeholder="https://…/mcp" value={form.endpointUrl} onChange={(e) => setForm({ ...form, endpointUrl: e.target.value })} />
          <select value={form.scopeKind} onChange={(e) => setForm({ ...form, scopeKind: e.target.value })}>
            <option value="workspace">workspace</option>
            <option value="user">user</option>
            <option value="agent">agent</option>
          </select>
          {form.scopeKind === 'agent' && (
            <select value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}>
              <option value="">选择 Agent…</option>
              {agents.map((a) => (
                <option key={a.agentId} value={a.agentId}>{a.name ?? a.agentId}</option>
              ))}
            </select>
          )}
          <button disabled={busy} onClick={register}>注册</button>
          <button onClick={load}>刷新</button>
        </div>
      </div>

      <div className="list">
        {servers.length === 0 && <p className="hint">暂无 MCP 服务器（Live 模式下可注册）。</p>}
        {servers.map((s) => (
          <div key={s.serverId} className="list-row ct-row">
            <div className="ct-main">
              <div className="sched-title">
                <strong>{s.displayName ?? s.serverId}</strong>
                <span className={`tag ${s.status === 'active' ? 'tag-live' : 'tag-mock'}`}>{s.status === 'active' ? '已激活' : '未激活'}</span>
                <span className="tag tag-mock">{scopeName(s)}</span>
                {s.status !== 'active' && mcpEndpointIssue(s.endpointUrl) && (
                  <span className="tag tag-mock" title={mcpEndpointIssue(s.endpointUrl)}>
                    本地/内网，云端不可连
                  </span>
                )}
              </div>
              <div className="agent-id">{s.endpointUrl} · {s.transport} · v{s.serverVersion}</div>
              {s.observation && (
                <div className="agent-id">
                  探测：协议 {s.observation.protocolVersion} · 凭据 v{s.observation.credentialVersion}
                  {s.observation.expiresAt ? ` · 有效期至 ${new Date(s.observation.expiresAt).toLocaleString('zh-CN')}` : ''}
                </div>
              )}
            </div>
            <div className="ct-actions">
              <button
                disabled={busy || (s.status !== 'active' && !!mcpEndpointIssue(s.endpointUrl))}
                onClick={() => toggleActive(s)}
              >
                {s.status === 'active' ? '停用' : '激活'}
              </button>
              <button
                onClick={async () => {
                  setCredOpen(credOpen === s.serverId ? null : s.serverId);
                  if (credOpen !== s.serverId) await loadCred(s);
                }}
              >
                {credOpen === s.serverId ? '收起凭据' : '凭据'}
              </button>
            </div>
            {credOpen === s.serverId && (
              <div className="ct-config">
                <div className="ct-cred-row">
                  <select
                    value={cred[s.serverId]?.authKind ?? 'none'}
                    onChange={(e) => setCred((p) => ({ ...p, [s.serverId]: { ...(p[s.serverId] ?? {}), authKind: e.target.value } }))}
                  >
                    <option value="none">无鉴权（none）</option>
                    <option value="static_bearer">Bearer 静态密钥</option>
                  </select>
                  {cred[s.serverId]?.authKind === 'static_bearer' && (
                    <input
                      type="password"
                      placeholder="Bearer 密钥"
                      value={cred[s.serverId]?.secret ?? ''}
                      onChange={(e) => setCred((p) => ({ ...p, [s.serverId]: { ...(p[s.serverId] ?? {}), secret: e.target.value } }))}
                    />
                  )}
                  <button disabled={busy} onClick={() => saveCredential(s)}>保存</button>
                  {cred[s.serverId]?.authKind === 'static_bearer' && Number(cred[s.serverId]?.currentVersion ?? 0) > 0 && (
                    <button disabled={busy} onClick={() => rotate(s)}>一键轮换</button>
                  )}
                  <span className="agent-id">
                    当前：{cred[s.serverId]?.authKind ?? '?'} · v{cred[s.serverId]?.currentVersion ?? 0}
                  </span>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
