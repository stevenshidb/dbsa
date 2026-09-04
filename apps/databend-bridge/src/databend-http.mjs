// 通过 Databend HTTP Handler（/v1/query/）执行 SQL。
// 契约：https://docs.databend.com/developer/apis/http

const DEFAULT_HEADERS = {
  'content-type': 'application/json',
  'user-agent': 'tidbsa-databend-bridge/0.1',
};

export function parseDsn(dsn) {
  if (!dsn || !/^databend:\/\//i.test(dsn)) {
    throw new Error('DATABEND_DSN 必须是 databend://user:password@host:port/db?warehouse=... 格式');
  }
  const url = new URL(String(dsn).replace(/^databend:\/\//i, 'https://'));
  const sslmode = (url.searchParams.get('sslmode') ?? '').toLowerCase();
  const protocol = sslmode === 'disable' || sslmode === 'false' ? 'http:' : 'https:';
  return {
    baseUrl: `${protocol}//${url.host}`,
    database: url.pathname.replace(/^\//, '') || 'default',
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    warehouse: url.searchParams.get('warehouse') || 'default',
  };
}

const basicHeader = (conn) =>
  `Basic ${Buffer.from(`${conn.username}:${conn.password}`, 'utf8').toString('base64')}`;

function errorText(payload, fallback) {
  return payload?.error?.message || payload?.error?.kind || fallback;
}

/**
 * 执行一条 SQL，返回 { columns, rows, truncated, count, command }。
 * 只读/写操作由 handler 的安全检查负责，这里只负责 HTTP 往返。
 */
export async function databendQuery(conn, sql, { timeoutSecs = 300, maxRows = 200 } = {}) {
  if (!conn || !conn.baseUrl) throw new Error('Databend 连接未初始化');
  const authorization = basicHeader(conn);
  const requestHeaders = {
    ...DEFAULT_HEADERS,
    authorization,
    'x-databend-warehouse': conn.warehouse,
  };
  const post = async (payload) => {
    const res = await fetch(`${conn.baseUrl}/v1/query/`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({
        sql: payload.sql ?? sql,
        pagination: {
          wait_time_secs: timeoutSecs,
          max_rows_in_buffer: maxRows + 1,
          max_rows_per_page: maxRows + 1,
        },
      }),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok || data?.error) {
      throw new Error(errorText(data, `Databend HTTP ${res.status} ${res.statusText}`));
    }
    return data;
  };

  let page = await post({ sql });
  let pageRows = Array.isArray(page?.data) ? page.data : [];
  let pages = 1;
  while (page?.next_uri && pages < 10) {
    const next = await fetch(`${conn.baseUrl}${page.next_uri.startsWith('/') ? '' : '/'}${page.next_uri}`, {
      headers: { authorization },
    });
    const text = await next.text();
    page = text ? JSON.parse(text) : {};
    if (Array.isArray(page?.data)) pageRows = pageRows.concat(page.data);
    pages += 1;
  }

  const schema = Array.isArray(page?.schema) ? page.schema : [];
  const names = schema.map((s) => s?.name || '').filter(Boolean);
  const truncated = pageRows.length > maxRows;
  const rows = pageRows.slice(0, maxRows).map((tuple) => {
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
  return {
    columns: names.length ? names : rows.length ? Object.keys(rows[0]) : [],
    rows,
    truncated,
    count: truncated ? maxRows : pageRows.length,
    command: page?.stats?.write_progress?.bytes ? 'write' : 'query',
  };
}
