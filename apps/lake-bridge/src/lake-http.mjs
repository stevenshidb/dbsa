// 通过 TiDB Cloud Lake REST API 执行 SQL。
// 协议来自 TiDB Cloud Lake 官方 LakeSQL 驱动（github.com/tidbcloud/lakesql）：
//   - POST /v1/session/login（Basic Auth）换取可选的 session_token；
//   - POST /v1/query 提交 SQL（JSON + 分页），响应格式与 Databend HTTP Handler 一致；
//   - 带 session_token 时用 Bearer，无 token 的兼容端点回退 Basic Auth；
//   - token 过期走 /v1/session/refresh 或重新 login。
// 本模块零依赖，只使用 Node 内置 fetch。

import { randomUUID } from 'node:crypto';

const USER_AGENT = 'tidbsa-lake-bridge/0.1';

function basicHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export function parseDsn(dsn) {
  if (!dsn || !/^lake:\/\//i.test(dsn)) {
    throw new Error('LAKE_DSN 必须是 lake://user:password@host:443/db?warehouse=... 格式');
  }
  const url = new URL(String(dsn).replace(/^lake:\/\//i, 'https://'));
  const sslmode = (url.searchParams.get('sslmode') ?? '').toLowerCase();
  const protocol = sslmode === 'disable' || sslmode === 'false' ? 'http:' : 'https:';
  const defaultPort = protocol === 'http:' ? 80 : 443;
  const port = url.port ? Number(url.port) : defaultPort;
  const username = url.username ? decodeURIComponent(url.username) : '';
  return {
    baseUrl: `${protocol}//${url.hostname}:${port}`,
    hostname: url.hostname,
    database: url.pathname.replace(/^\//, '') || 'default',
    username,
    password: decodeURIComponent(url.password || ''),
    warehouse: url.searchParams.get('warehouse') || '',
    tenant: url.searchParams.get('tenant') || '',
    role: url.searchParams.get('role') || '',
  };
}

function jsonError(payload, fallback) {
  const error = payload?.error;
  if (error && typeof error === 'object') {
    return `${error.code ? `[${error.code}] ` : ''}${error.message || 'Lake query error'}`;
  }
  return error?.message || error?.kind || fallback;
}

async function readJson(res, fallback) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 400) || fallback } };
  }
}

function rowObjects(schema, pageRows, maxRows) {
  const names = Array.isArray(schema)
    ? schema.map((field) => field?.name || '').filter(Boolean)
    : [];
  return pageRows.slice(0, maxRows).map((tuple) => {
    if (names.length === 0 && Array.isArray(tuple)) {
      const out = {};
      tuple.forEach((value, i) => {
        out[`col_${i + 1}`] = value;
      });
      return out;
    }
    const obj = {};
    names.forEach((name, i) => {
      obj[name] = tuple?.[i];
    });
    return obj;
  });
}

/**
 * 创建 TiDB Cloud Lake 查询客户端。
 * @returns {{ run(sql: string): Promise<object>, dispose(): Promise<void>, summary(): object }}
 */
export function createLakeQueryClient({
  dsn,
  timeoutSecs = 300,
  maxRows = 200,
  logger = console,
} = {}) {
  if (!dsn) throw new Error('缺少 LAKE_DSN');
  const conn = parseDsn(dsn);
  const basic = basicHeader(conn.username, conn.password);

  let routeNonce = 0;
  const nextRouteHint = () => {
    routeNonce += 1;
    return `rh:${randomUUID()}:${String(routeNonce).padStart(6, '0')}`;
  };

  // 会话状态：token 可用前使用 Basic；云 Lake 一般 login 后返回 session_token。
  const session = {
    mode: 'basic', // 'basic' | 'token'
    sessionToken: '',
    refreshToken: '',
    sessionTokenExpiresAt: 0,
    sessionId: '',
    loginTried: false,
  };

  const requestHeaders = (auth, queryId) => {
    const headers = {
      authorization: auth,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': USER_AGENT,
      'x-databend-route-hint': nextRouteHint(),
    };
    if (conn.warehouse) headers['x-databend-warehouse'] = conn.warehouse;
    if (conn.tenant) headers['x-databend-tenant'] = conn.tenant;
    if (queryId) headers['x-databend-query-id'] = queryId;
    return headers;
  };

  const currentAuth = () =>
    session.mode === 'token' && session.sessionToken
      ? `Bearer ${session.sessionToken}`
      : basic;

  const login = async () => {
    if (session.loginTried) return;
    session.loginTried = true;
    const body = {};
    if (conn.database) body.database = conn.database;
    if (conn.role) body.role = conn.role;
    let res;
    try {
      res = await fetch(`${conn.baseUrl}/v1/session/login`, {
        method: 'POST',
        headers: requestHeaders(basic),
        body: JSON.stringify(body),
      });
    } catch (error) {
      logger.warn?.('[lake-http] login 请求失败，降级为 Basic 直连：', error?.message);
      session.mode = 'basic';
      return;
    }

    // 兼容未启用 session login 的端点（404/405 表示走纯 Basic）。
    if (res.status === 404 || res.status === 405) {
      session.mode = 'basic';
      return;
    }
    const payload = await readJson(res, `Lake login HTTP ${res.status}`);
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Lake 登录失败（${res.status}），请检查 DSN 用户名/密码：${jsonError(payload, res.statusText)}`);
      }
      // 其它服务端错误时保留 Basic 直连尝试，让 query 暴露最终结果。
      logger.warn?.('[lake-http] login 未成功，回退 Basic：', jsonError(payload, res.statusText));
      session.mode = 'basic';
      return;
    }
    const sessionId = res.headers.get('x-databend-session-id') || '';
    const tokens = payload?.tokens ?? null;
    if (tokens?.session_token) {
      session.mode = 'token';
      session.sessionToken = tokens.session_token;
      session.refreshToken = tokens.refresh_token || '';
      session.sessionTokenExpiresAt =
        Date.now() + Number(tokens.session_token_ttl_in_secs ?? 3600) * 1000;
      session.sessionId = sessionId;
    } else {
      session.mode = 'basic';
      session.sessionId = sessionId;
    }
  };

  const refreshSession = async () => {
    if (session.mode !== 'token') return;
    if (!session.refreshToken) {
      // 没有 refresh token 时重新 login。
      session.loginTried = false;
      session.mode = 'basic';
      await login();
      return;
    }
    let res;
    try {
      res = await fetch(`${conn.baseUrl}/v1/session/refresh`, {
        method: 'POST',
        headers: requestHeaders(`Bearer ${session.refreshToken}`),
        body: JSON.stringify({ session_token: session.sessionToken }),
      });
    } catch (error) {
      logger.warn?.('[lake-http] refresh 请求失败：', error?.message);
      session.loginTried = false;
      session.mode = 'basic';
      await login();
      return;
    }
    const payload = await readJson(res, `Lake refresh HTTP ${res.status}`);
    if (!res.ok || !payload?.session_token) {
      session.loginTried = false;
      session.mode = 'basic';
      await login();
      return;
    }
    session.sessionToken = payload.session_token;
    session.refreshToken = payload.refresh_token || session.refreshToken;
    session.sessionTokenExpiresAt =
      Date.now() + Number(payload.session_token_ttl_in_secs ?? 3600) * 1000;
  };

  const ensureSession = async () => {
    if (session.mode === 'token') {
      if (Date.now() + 30000 < session.sessionTokenExpiresAt) return;
      await refreshSession();
      return;
    }
    await login();
  };

  const queryPage = async (sql, { first = true, nextUri = '', queryId = '' } = {}) => {
    await ensureSession();
    const url = first
      ? `${conn.baseUrl}/v1/query`
      : `${conn.baseUrl}${nextUri.startsWith('/') ? nextUri : `/${nextUri}`}`;
    const init = {
      method: first ? 'POST' : 'GET',
      headers: requestHeaders(currentAuth(), queryId || (first ? randomUUID() : queryId)),
      ...(first
        ? {
            body: JSON.stringify({
              sql,
              ...(conn.database ? { session: { database: conn.database, ...(conn.role ? { role: conn.role } : {}) } } : {}),
              pagination: {
                wait_time_secs: timeoutSecs,
                max_rows_in_buffer: maxRows + 1,
                max_rows_per_page: maxRows + 1,
              },
            }),
          }
        : {}),
    };
    let res;
    try {
      res = await fetch(url, init);
    } catch (error) {
      throw new Error(`无法连接 TiDB Cloud Lake（${conn.baseUrl}）：${error?.message || error}`);
    }
    const payload = await readJson(res, `Lake HTTP ${res.status} ${res.statusText}`);
    if (!res.ok || payload?.error) {
      const err = new Error(jsonError(payload, `Lake HTTP ${res.status} ${res.statusText}`));
      err.status = res.status;
      throw err;
    }
    return payload;
  };

  const run = async (sql) => {
    const queryId = randomUUID();
    let page;
    let retried = false;
    try {
      page = await queryPage(sql, { first: true, queryId });
    } catch (error) {
      // token 过期导致 401：refresh/re-login 后重试一次。
      if (
        session.mode === 'token' &&
        error?.status === 401 &&
        !retried
      ) {
        retried = true;
        await refreshSession();
        page = await queryPage(sql, { first: true, queryId });
      } else {
        throw error;
      }
    }

    let pageRows = Array.isArray(page?.data) ? page.data : [];
    let pages = 1;
    let nextUri = page?.next_uri;
    while (nextUri && pages < 10) {
      const next = await queryPage(sql, { first: false, nextUri, queryId });
      if (Array.isArray(next?.data)) pageRows = pageRows.concat(next.data);
      nextUri = next?.next_uri;
      pages += 1;
    }

    const schema = Array.isArray(page?.schema) ? page.schema : [];
    const names = schema.map((field) => field?.name || '').filter(Boolean);
    const truncated = pageRows.length > maxRows;
    const rows = rowObjects(schema, pageRows, maxRows);
    return {
      columns: names.length ? names : rows.length ? Object.keys(rows[0]) : [],
      rows,
      truncated,
      count: truncated ? maxRows : pageRows.length,
      command: page?.stats?.write_progress?.rows || page?.stats?.write_progress?.bytes ? 'write' : 'query',
    };
  };

  const dispose = async () => {
    if (session.mode !== 'token' || !session.sessionId) return;
    try {
      await fetch(`${conn.baseUrl}/v1/session/logout`, {
        method: 'POST',
        headers: requestHeaders(currentAuth()),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // 忽略登出错误；token 会自动过期。
    }
  };

  return {
    run,
    dispose,
    summary: () => ({
      baseUrl: conn.baseUrl,
      database: conn.database,
      warehouse: conn.warehouse || '(DSN 未指定)',
      user: conn.username,
      authMode: session.mode,
    }),
  };
}
