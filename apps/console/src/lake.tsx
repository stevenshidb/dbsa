import { useEffect, useState } from 'react';

const friendly = (err) => err?.message ?? String(err);

export default function LakeConnector({
  client,
  live,
  agents,
  selectedAgentId,
  onNotice,
  onChanged,
}) {
  const [form, setForm] = useState({
    displayName: 'TiDB Cloud Lake 数据源',
    endpointUrl: '',
    bearer: '',
    agentId: '',
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setForm((p) => ({ ...p, agentId: selectedAgentId || agents[0]?.agentId || '' }));
  }, [selectedAgentId, agents]);

  const agentName = (id) =>
    agents.find((a) => a.agentId === id)?.name || id || '未选择';

  const connect = async () => {
    const endpointUrl = form.endpointUrl.trim();
    const agentId = form.agentId;
    if (!live) {
      onNotice?.('Mock 模式：一键接入将在 Live 模式下执行');
      return;
    }
    if (!/^https:\/\//i.test(endpointUrl)) {
      return onNotice?.('Agent9 的 MCP 端点必须是 https:// 公网地址。内网桥可用后请通过 TLS 反代暴露。');
    }
    if (!agentId) return onNotice?.('请先在左上角选择要挂载的 Agent');
    setBusy(true);
    const steps = [];
    try {
      const listRes = await client.listMcpServers();
      const list = listRes?.servers ?? listRes ?? [];
      let server = list.find(
        (s) =>
          s.endpointUrl === endpointUrl &&
          s.scope?.kind === 'agent' &&
          s.scope?.id === agentId,
      );
      if (server) {
        steps.push(`复用已有注册 ${server.serverId}`);
      } else {
        const created = await client.createMcpServer({
          displayName: form.displayName.trim() || 'TiDB Cloud Lake 数据源',
          endpointUrl,
          scope: { kind: 'agent', agentId },
        });
        server = created?.server ?? created;
        steps.push(`已注册 ${server.serverId}`);
      }
      const serverId = server?.serverId;
      if (!serverId) throw new Error('Agent9 未返回 serverId');

      if (server.status !== 'active') {
        const viewRes = await client.getMcpCredential(serverId);
        const existing = viewRes?.credential ?? viewRes ?? null;
        const expected =
          existing?.credentialBindingId
            ? {
                expectedCredentialBindingId: existing.credentialBindingId,
                expectedCurrentVersion: existing.currentVersion,
              }
            : {};
        const credential = form.bearer.trim()
          ? await client.putMcpCredential(serverId, {
              authKind: 'static_bearer',
              secret: form.bearer.trim(),
              ...expected,
            })
          : await client.putMcpCredential(serverId, { authKind: 'none', ...expected });
        const cred = credential?.credential ?? credential ?? {};
        steps.push(`凭据 ${cred.authKind ?? 'none'} v${cred.currentVersion ?? 0}`);

        const activated = await client.activateMcpServer(serverId, server.serverVersion);
        const active = activated?.server ?? activated;
        steps.push(
          `已激活（${active.status} · 协议 ${active.observation?.protocolVersion ?? 'unknown'}）`,
        );
      } else {
        steps.push('注册已激活，跳过凭据/激活');
      }

      const agentRes = await client.getAgent(agentId);
      const agent = agentRes?.agent ?? agentRes;
      const etag = agentRes?._responseHeaders?.etag;
      if (!etag) throw new Error('读取 Agent ETag 失败');
      const tools = agent?.config?.tools ?? { managed: [] };
      const mcp = Array.isArray(tools.mcp) ? tools.mcp.filter((x) => x?.serverId) : [];
      if (!mcp.some((x) => x.serverId === serverId)) mcp.push({ serverId });
      await client.patchAgentConfig(
        agentId,
        { tools: { managed: Array.isArray(tools.managed) ? tools.managed : [], mcp } },
        { ifMatch: etag },
      );
      steps.push(`已挂载到「${agent?.name ?? agentId}」`);

      onNotice?.(`TiDB Cloud Lake 接入完成：\n${steps.join('\n')}`);
      onChanged?.();
    } catch (err) {
      onNotice?.(`TiDB Cloud Lake 接入失败：${friendly(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connector-card">
      <div className="card-title">
        <strong>TiDB Cloud Lake 数据源（MCP 路径 A）</strong>
        <span className="tag tag-live">{live ? 'Live' : 'Mock'}</span>
      </div>
      <p className="hint">
        前置：已用 <code>pnpm lake:bridge</code> 启动本机桥，并经 TLS 反向代理暴露为
        https://…/mcp。填写后一键「注册 → 绑定凭据 → 激活 → 挂载到当前专家 Agent」。
      </p>
      <div className="conn-form">
        <label>显示名称
          <input
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          />
        </label>
        <label>桥端点（https://…/mcp）
          <input
            value={form.endpointUrl}
            placeholder="https://mcp.example.com/mcp"
            onChange={(e) => setForm({ ...form, endpointUrl: e.target.value })}
          />
        </label>
        <label>桥 Bearer（可为空 = none）
          <input
            type="password"
            value={form.bearer}
            placeholder="可选"
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
            {busy ? '接入中…' : '一键注册 · 激活 · 挂载'}
          </button>
        </div>
      </div>
      {!form.agentId && <p className="hint">当前将挂载到：{agentName(form.agentId)}（请选择）</p>}
    </div>
  );
}
