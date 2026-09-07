import { useEffect, useState } from 'react';

const friendly = (err) => err?.message ?? String(err);

const PRIVATE_HOST = new RegExp(
  [
    '(^|\\.)localhost$',
    '(^|\\.)local$',
    '(^|\\.)lan$',
    '(^|\\.)internal$',
    '^127\\.',
    '^10\\.',
    '^192\\.168\\.',
    '^172\\.(1[6-9]|2[0-9]|3[01])\\.',
    '^169\\.254\\.',
    '^100\\.(6[4-9]|[7-9][0-9])\\.',
    '^0\\.',
    '^::1$',
    '^fe80:',
    '^fc',
    '^fd',
  ].join('|'),
  'i',
);

/** 返回 null 表示可安全注册；否则返回给用户看的修复提示。 */
export function mcpEndpointIssue(endpointUrl) {
  let url;
  try {
    url = new URL(endpointUrl);
  } catch {
    return '不是合法的 URL';
  }
  if (url.protocol !== 'https:') return 'Agent9 只接受 https:// 的 MCP 地址';
  if (url.username || url.password) return 'MCP 地址不能内嵌用户名/密码';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || PRIVATE_HOST.test(host)) {
    return `“${endpointUrl}” 是本地/内网地址，云端 Agent9 无法访问。请先运行 pnpm lake:bridge，再把它通过公网域名 + TLS 暴露成 https://…/mcp 后填写。`;
  }
  return null;
}

const maskEndpoint = (endpointUrl) => {
  try {
    const u = new URL(endpointUrl);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return endpointUrl;
  }
};

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
    const issue = mcpEndpointIssue(endpointUrl);
    if (issue) {
      onNotice?.(issue);
      return;
    }
    if (!agentId) return onNotice?.('请先选择要挂载的 Agent');

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
        // 用户早期把 127.0.0.1/localhost 填进注册，云端永远连不上；这里自动把
        // 同一个 Agent 下的这类旧注册迁移到新的公网地址，而不是再新建一条。
        const stale = list.find(
          (s) =>
            s.status !== 'active' &&
            s.scope?.kind === 'agent' &&
            s.scope?.id === agentId &&
            (mcpEndpointIssue(s.endpointUrl) !== null ||
              /lake|tidb/i.test(String(s.displayName ?? ''))),
        );
        if (stale) {
          const patched = await client.updateMcpServer(stale.serverId, {
            expectedServerVersion: stale.serverVersion,
            displayName: 'TiDB Cloud Lake',
            endpointUrl,
          });
          server = patched?.server ?? patched;
          steps.push(
            `已把旧注册 ${stale.serverId}（${maskEndpoint(stale.endpointUrl)}）迁移到新地址`,
          );
        }
      }
      if (!server) {
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

      // 始终以最新注册状态为准，避免版本号陈旧。
      const freshRes = await client.getMcpServer(serverId);
      const fresh = freshRes?.server ?? freshRes;
      server = fresh ?? server;

      if (server?.status !== 'active') {
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

        // 绑定凭据会推进注册状态，重读后再激活。
        const afterCredRes = await client.getMcpServer(serverId);
        const afterCred = afterCredRes?.server ?? afterCredRes ?? {};
        if (!Number.isInteger(afterCred.serverVersion)) {
          throw new Error('读取最新注册版本失败，请刷新后重试');
        }
        const activated = await client.activateMcpServer(serverId, afterCred.serverVersion);
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
      const message = friendly(err);
      const hint = /Internal Server Error|HTTP 500|http_500/i.test(message)
        ? '\n提示：500 通常是 Agent9 云无法连通你填写的端点。请确认：1) 地址是公网可达的 https://…/mcp，不是 127.0.0.1/localhost/内网 IP；2) pnpm lake:bridge 正在运行且经 TLS 暴露；3) 端点若设了 Bearer，访问密钥要填写一致。'
        : /credential.*(missing|stale)|missing or stale/i.test(message)
          ? '\n提示：凭据状态仍未匹配。可先在下方 MCP 服务器列表中停用/删除后重试，或核对端点要求无鉴权还是有 Bearer。'
          : '';
      onNotice?.(`连接 TiDB Cloud Lake 失败：${message}${hint}`);
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
        填入 Agent9 能访问到的 Lake MCP 公网地址（<code>pnpm lake:bridge</code>
        经域名 + TLS 暴露后的 https://…/mcp，或企业托管端点）。不能填
        127.0.0.1/localhost/内网 IP。可选填访问密钥，点一下即可连接并挂载到 Agent。
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
