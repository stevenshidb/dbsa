// 外部 MCP（streamable_http）一键接入的共享逻辑：
// 注册/复用 → 绑定凭据 → 激活 → 挂载到 Agent。

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
export function mcpEndpointIssue(endpointUrl, localHint = '') {
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
    return `“${endpointUrl}” 是本地/内网地址，云端 Agent9 无法访问。${
      localHint || '请通过公网域名 + TLS 暴露成 https://…/mcp 后填写。'
    }`;
  }
  return null;
}

export const maskEndpoint = (endpointUrl) => {
  try {
    const u = new URL(endpointUrl);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return endpointUrl;
  }
};

/**
 * 把外部 streamable_http MCP 端点一键接入 Agent：
 * - 已存在同端点+同 Agent 的注册则复用；
 * - 存在旧的本地/内网且同名的失败注册则自动迁移到新地址；
 * - 未激活则绑定凭据（Bearer 或无鉴权）后激活；
 * - 最后把 serverId 挂进 Agent.config.tools.mcp。
 */
export async function connectExternalMcp({
  client,
  endpointUrl,
  bearer = '',
  agentId,
  displayName,
  matchName = displayName,
  onStep = (_msg) => {},
}) {
  const steps = [];
  const note = (msg) => {
    steps.push(msg);
    onStep?.(msg);
  };

  const listRes = await client.listMcpServers();
  const list = listRes?.servers ?? listRes ?? [];
  let server = list.find(
    (s) =>
      s.endpointUrl === endpointUrl &&
      s.scope?.kind === 'agent' &&
      s.scope?.id === agentId,
  );
  if (server) {
    note(`复用已有注册 ${server.serverId}`);
  } else {
    // 用户早期把 127.0.0.1/localhost 填进注册，云端永远连不上；这里自动把
    // 同一个 Agent 下的同名旧注册迁移到新的公网地址，而不是再新建一条。
    const stale = list.find(
      (s) =>
        s.status !== 'active' &&
        s.scope?.kind === 'agent' &&
        s.scope?.id === agentId &&
        mcpEndpointIssue(s.endpointUrl) !== null &&
        (!matchName || String(s.displayName ?? '').includes(matchName)),
    );
    if (stale) {
      const patched = await client.updateMcpServer(stale.serverId, {
        expectedServerVersion: stale.serverVersion,
        displayName,
        endpointUrl,
      });
      server = patched?.server ?? patched;
      note(
        `已把旧注册 ${stale.serverId}（${maskEndpoint(stale.endpointUrl)}）迁移到新地址`,
      );
    }
  }
  if (!server) {
    const created = await client.createMcpServer({
      displayName,
      endpointUrl,
      scope: { kind: 'agent', agentId },
    });
    server = created?.server ?? created;
    const id = server?.serverId;
    if (!id) throw new Error('Agent9 未返回 serverId');
    note(`已注册 ${id}`);
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
    const expected = existing?.credentialBindingId
      ? {
          expectedCredentialBindingId: existing.credentialBindingId,
          expectedCurrentVersion: existing.currentVersion,
        }
      : {};
    const secret = String(bearer ?? '').trim();
    const credential = secret
      ? await client.putMcpCredential(serverId, {
          authKind: 'static_bearer',
          secret,
          ...expected,
        })
      : await client.putMcpCredential(serverId, { authKind: 'none', ...expected });
    const cred = credential?.credential ?? credential ?? {};
    note(cred.authKind === 'static_bearer' ? '访问密钥已绑定' : '无鉴权');

    // 绑定凭据会推进注册状态，重读后再激活。
    const afterCredRes = await client.getMcpServer(serverId);
    const afterCred = afterCredRes?.server ?? afterCredRes ?? {};
    if (!Number.isInteger(afterCred.serverVersion)) {
      throw new Error('读取最新注册版本失败，请刷新后重试');
    }
    const activated = await client.activateMcpServer(serverId, afterCred.serverVersion);
    const active = activated?.server ?? activated;
    note(
      `已激活（${active.status} · 协议 ${active.observation?.protocolVersion ?? 'unknown'}）`,
    );
  } else {
    note('注册已激活，跳过密钥/激活');
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
  note(`已挂载到「${agent?.name ?? agentId}」`);

  return { serverId, steps, agent };
}
