// Databend MCP bridge 运行配置。
// 只在环境变量与 .env 里读取，不把 DSN 密码写进任何代码/日志。

const boolEnv = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

export function readConfig(env = process.env) {
  const safeMode = boolEnv(env.DATABEND_MCP_SAFE_MODE, true);
  const port = Number(env.DATABEND_MCP_BIND_PORT ?? env.PORT ?? 8001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`无效端口：${env.DATABEND_MCP_BIND_PORT}`);
  }
  return {
    dsn: env.DATABEND_DSN || '',
    safeMode,
    queryTimeoutSecs: Math.max(1, Number(env.DATABEND_QUERY_TIMEOUT ?? 300)),
    bindHost: env.DATABEND_MCP_BIND_HOST || '127.0.0.1',
    bindPort: port,
    mcpPath: env.DATABEND_MCP_PATH || '/mcp',
    bearer: env.DATABEND_BRIDGE_BEARER || env.MCP_BRIDGE_BEARER || '',
    maxRows: Math.min(
      2000,
      Math.max(1, Number(env.DATABEND_MCP_MAX_ROWS ?? 200)),
    ),
  };
}

export function summarizeDsn(dsn) {
  try {
    const u = new URL(String(dsn).replace(/^databend:\/\//i, 'https://'));
    return {
      host: u.host,
      database: u.pathname.replace(/^\//, '') || 'default',
      warehouse: u.searchParams.get('warehouse') ?? 'default',
      user: u.username ? decodeURIComponent(u.username) : '',
    };
  } catch {
    return null;
  }
}
