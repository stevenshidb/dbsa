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
    if (!/^https:\/\//i.test(endpointUrl)) {
      return onNotice?.('请填写 Agent9 可访问的 Lake MCP 端点，格式必须为 https://…/mcp');
    }
    if (!agentId) return onNotice?.('请先选择要挂载的 Agent');

    setBusy(true);
    const steps = [];
    try {
      // 复用同一 Agent 下同端点的注册，避免重复。
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
          displayName: 'TiDB Cloud Lake',
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
        const bearer = form.bearer.trim();
        const credential = bearer
          ? await client.putMcpCredential(serverId, {
              authKind: 'static_bearer',
              secret: bearer,
              ...expected,
            })
          : await client.putMcpCredential(serverId, { authKind: 'none', ...expected });
        const cred = credential?.credential ?? credential ?? {};
        steps.push(cred.authKind === 'static_bearer' ? '访问密钥已绑定' : '无鉴权');

        const activated = await client.activateMcpServer(serverId, server.serverVersion);
        const active = activated?.server ?? activated;
        steps.push(
          `已激活（${active.status} · 协议 ${active.observation?.protocolVersion ?? 'unknown'}）`,
        );
      } else {
        steps.push('注册已激活，跳过密钥/激活');
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

      onNotice?.(`TiDB Cloud Lake 连接成功：\n${steps.join('\n')}`);
      onChanged?.();
    } catch (err) {
      onNotice?.(`连接 TiDB Cloud Lake 失败：${friendly(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connector-card">
      <div className="card-title">
        <strong>TiDB Cloud Lake（MCP 数据源）</strong>
        <span className="tag tag-live">{live ? 'Live' : 'Mock'}</span>
      </div>
      <p className="hint">
        把 Agent9 能访问到的 Lake MCP 地址粘贴到下面（本机运行
        <code> pnpm lake:bridge </code>后经 TLS 暴露的 https://…/mcp，或企业版托管端点）。
        可选填访问密钥，点一下即可注册、激活并挂载到所选 Agent。
      </p>
      <div className="conn-form">
        <label>Lake MCP 地址（https://…/mcp）
          <input
            value={form.endpointUrl}
            placeholder="https://lake-mcp.example.com/mcp"
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
