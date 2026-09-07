// 路径 A 的 Agent9 侧接入：注册 TiDB Cloud Lake MCP Server（agent scope）→ 配置凭据 → 激活 → 挂载到 Agent。
// 只使用 packages/client 已暴露的 MCP 方法，字段与 agent9 origin/main src/mcp 契约对齐。

const MCP_SERVER_PATTERN = /^mcp_[a-f0-9-]{36}$/;
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
    return `“${endpointUrl}” 是本地/内网地址，云端 Agent9 无法访问。请把 pnpm lake:bridge 通过公网域名 + TLS 暴露成 https://…/mcp 后填写。`;
  }
  return null;
}

async function findExisting(client, agentId, endpointUrl) {
  const res = await client.listMcpServers().catch(() => null);
  const servers = res?.servers ?? res ?? [];
  return (
    servers.find(
      (s) =>
        s.endpointUrl === endpointUrl &&
        s.scope?.kind === 'agent' &&
        s.scope?.id === agentId,
    ) ?? null
  );
}

async function getAgentWithEtag(client, agentId) {
  const res = await client.getAgent(agentId);
  const agent = res?.agent ?? res;
  return {
    agent,
    etag: res?._responseHeaders?.etag,
  };
}

/**
 * 注册（若不存在）→ 绑定凭据 → 激活 → 把 serverId 写进 Agent.config.tools.mcp。
 */
export async function connectLakeMcp(
  client,
  {
    endpointUrl,
    bearer = '',
    agentId,
    displayName = 'TiDB Cloud Lake 数据源',
    logger = console,
  },
) {
  if (!agentId) throw new Error('请提供 agentId（--agent）');
  if (!/^https:\/\//i.test(endpointUrl)) {
    throw new Error(`Agent9 只接受 https:// 的 MCP 端点，当前：${endpointUrl}`);
  }
  const issue = mcpEndpointIssue(endpointUrl);
  if (issue) throw new Error(issue);

  let server = await findExisting(client, agentId, endpointUrl);
  if (!server) {
    // 复用本 Agent 下早期误填 127.0.0.1/localhost/内网地址的未激活注册并迁移地址。
    const res = await client.listMcpServers().catch(() => null);
    const all = res?.servers ?? res ?? [];
    const stale = all.find(
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
        displayName,
        endpointUrl,
      });
      server = patched?.server ?? patched;
      logger.log(`已把旧注册 ${stale.serverId} 迁移到 ${endpointUrl}`);
    } else {
      const created = await client.createMcpServer({
        displayName,
        endpointUrl,
        scope: { kind: 'agent', agentId },
      });
      server = created?.server ?? created;
      logger.log(`已创建 MCP 注册：${server.serverId}`);
    }
  } else {
    logger.log(`复用已有 MCP 注册：${server.serverId}（status=${server.status}）`);
  }
  const serverId = server.serverId;

  // 始终以最新注册状态为准：创建/复用/绑定凭据都会推进 serverVersion，
  // 直接用旧值激活会被 Agent9 判为 “credential is missing or stale”。
  const freshRes = await client.getMcpServer(serverId);
  server = freshRes?.server ?? freshRes ?? server;

  // 凭据只允许在 inactive 状态写入。
  if (server.status === 'active') {
    const credential = await client.getMcpCredential(serverId);
    const current = credential?.credential ?? credential;
    if (current && (bearer ? current.authKind === 'static_bearer' : current.authKind === 'none')) {
      logger.log('注册已激活且凭据匹配，跳过重配。');
    } else {
      throw new Error('注册已激活但凭据不匹配：请先在 Web 端停用后再执行 connect');
    }
  } else {
    // 复用 inactive 注册时可能已有旧凭据：替换必须带上当前 binding id / version。
    const credentialView = await client.getMcpCredential(serverId);
    const existingCredential = credentialView?.credential ?? credentialView ?? null;
    const expected =
      existingCredential && existingCredential.credentialBindingId
        ? {
            expectedCredentialBindingId: existingCredential.credentialBindingId,
            expectedCurrentVersion: existingCredential.currentVersion,
          }
        : {};
    const put = bearer
      ? await client.putMcpCredential(serverId, {
          authKind: 'static_bearer',
          secret: bearer,
          ...expected,
        })
      : await client.putMcpCredential(serverId, { authKind: 'none', ...expected });
    logger.log(
      `凭据已绑定：${put?.credential?.authKind ?? put?.authKind ?? 'none'} v${put?.credential?.currentVersion ?? put?.currentVersion ?? 0}`,
    );
    // 绑定凭据后再读一次最新版本，确保激活乐观锁命中。
    const afterCredRes = await client.getMcpServer(serverId);
    const afterCred = afterCredRes?.server ?? afterCredRes ?? {};
    if (!Number.isInteger(afterCred.serverVersion)) {
      throw new Error('绑定凭据后无法读取最新注册版本，请检查 Agent9 网络后重试');
    }
    const activated = await client.activateMcpServer(serverId, afterCred.serverVersion);
    server = activated?.server ?? activated;
    logger.log(
      `激活成功：${server.status} · 协议 ${server.observation?.protocolVersion ?? 'unknown'} · ${server.observation?.remoteServerName ?? server.displayName}`,
    );
  }

  // 挂载到 Agent.config.tools.mcp
  const { agent, etag } = await getAgentWithEtag(client, agentId);
  if (!etag) throw new Error('读取 Agent ETag 失败，无法安全更新配置');
  const tools = agent?.config?.tools ?? { managed: [] };
  const mcp = Array.isArray(tools.mcp) ? tools.mcp.filter((x) => MCP_SERVER_PATTERN.test(x.serverId)) : [];
  if (!mcp.some((x) => x.serverId === serverId)) mcp.push({ serverId });
  await client.patchAgentConfig(
    agentId,
    { tools: { managed: Array.isArray(tools.managed) ? tools.managed : [], mcp } },
    { ifMatch: etag },
  );
  logger.log(`已挂载到 Agent ${agentId} 的 tools.mcp（当前 ${mcp.length} 个）`);

  return { serverId, agentId, tools: mcp.map((x) => x.serverId) };
}
