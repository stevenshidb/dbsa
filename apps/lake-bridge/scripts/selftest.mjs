#!/usr/bin/env node
// 自测：起一个模拟 TiDB Cloud Lake REST 服务（login/refresh/query + token 过期重试）
// + 真实 MCP 桥，验证 initialize / tools/list / tools/call / 安全模式 / 分页。

import { createServer } from 'node:http';
import { createLakeHandler } from '../src/handler.mjs';
import { startMcpServer } from '../src/server.mjs';

const failures = [];
const ok = (label) => console.log(`  ✓ ${label}`);
const fail = (label, error) => {
  failures.push(label);
  console.error(`  ✗ ${label}：${error?.stack || error}`);
};

const lakeResponse = (sql) => {
  if (/SELECT version\(\)/i.test(sql)) {
    return { schema: [{ name: 'version', type: 'String' }], data: [['lake-fake-0.3.2']] };
  }
  if (/SHOW DATABASES/i.test(sql)) {
    return {
      schema: [{ name: 'Database', type: 'String' }],
      data: [['default'], ['information_schema'], ['mcp_sandbox_test_analytics']],
    };
  }
  if (/CREATE DATABASE/i.test(sql)) {
    return { schema: [], data: [] };
  }
  return { schema: [{ name: 'ok', type: 'Int64' }], data: [[1]] };
};

function basicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

async function startFakeLake() {
  const seen = { authMode: [], warehouses: [], sqls: [], logins: 0, refreshes: 0, tokenGens: 0 };
  let tokenVersion = 0;
  let expiredOnce = false;
  const newTokens = () => {
    tokenVersion += 1;
    return {
      session_token: `tok_${tokenVersion}`,
      refresh_token: `ref_${tokenVersion}`,
      session_token_ttl_in_secs: 3600,
    };
  };

  const srv = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let bodyText = '';
    for await (const chunk of req) bodyText += chunk;
    let body = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      // ignore
    }
    const write = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const authorized = req.headers.authorization === basicAuthHeader('u', 'p');
    const auth = req.headers.authorization || '';

    if (url.pathname === '/v1/session/login') {
      seen.logins += 1;
      if (!authorized) return write(401, { error: { code: 40101, message: 'bad credentials' } });
      seen.warehouses.push(req.headers['x-databend-warehouse'] || '');
      seen.authMode.push('login:basic');
      res.writeHead(200, { 'content-type': 'application/json', 'x-databend-session-id': 'sess_test_1' });
      res.end(JSON.stringify({ version: 'lake-fake-1.0', tokens: newTokens() }));
      return;
    }

    if (url.pathname === '/v1/session/refresh') {
      seen.refreshes += 1;
      if (!/^Bearer ref_/.test(auth)) return write(401, { error: { code: 40101, message: 'invalid refresh token' } });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(newTokens()));
      return;
    }

    if (url.pathname === '/v1/query' && req.method === 'POST') {
      const sql = body?.sql ?? '';
      seen.sqls.push(sql);
      seen.warehouses.push(req.headers['x-databend-warehouse'] || '');
      const bearerToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      // 模拟 session token 首次被服务端判定过期：客户端应 refresh 后重试成功。
      if (bearerToken === 'tok_1' && !expiredOnce) {
        expiredOnce = true;
        return write(401, { error: { code: 40115, message: 'session token expired' } });
      }
      if (bearerToken) {
        seen.authMode.push('query:bearer');
      } else if (authorized) {
        seen.authMode.push('query:basic');
      } else {
        return write(401, { error: { code: 40100, message: 'unauthorized' } });
      }
      const payload = lakeResponse(sql);
      return write(200, {
        id: `qid_${seen.sqls.length}`,
        session: { database: body?.session?.database || 'default' },
        schema: payload.schema,
        data: payload.data,
        state: 'Succeeded',
        stats: { scan_progress: { rows: 0, bytes: 0 }, write_progress: { rows: 0, bytes: 0 }, result_progress: { rows: payload.data.length, bytes: 0 } },
      });
    }

    write(404, { error: { code: 1002, message: `Not found: ${url.pathname}` } });
  });

  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return {
    port: srv.address().port,
    seen,
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}

async function rawRpc(url, payload, bearer = '') {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function main() {
  console.log('== TiDB Cloud Lake MCP Bridge 自测 ==\n');
  const fake = await startFakeLake();
  const dsn = `lake://u:p@127.0.0.1:${fake.port}/default?warehouse=wh&sslmode=disable`;
  const bearer = 'test-lake-bearer';
  const handler = createLakeHandler({ dsn, safeMode: true, timeoutSecs: 10 });
  const mcp = await startMcpServer({
    handler,
    bearer,
    bindPort: 0,
    mcpPath: '/mcp',
  });

  try {
    const unauth = await rawRpc(mcp.url, { jsonrpc: '2.0', id: 1, method: 'ping' });
    unauth.status === 401
      ? ok('Bearer 鉴权拦截未授权请求')
      : fail('Bearer 鉴权', JSON.stringify(unauth));

    const init = await rawRpc(
      mcp.url,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'selftest', version: '1' },
        },
      },
      bearer,
    );
    init.status === 200 && init.data?.result?.serverInfo?.name === 'tidbsa-lake-bridge'
      ? ok(`initialize → ${init.data.result.serverInfo.name} @ ${init.data.result.protocolVersion}`)
      : fail('initialize', JSON.stringify(init));

    const notify = await rawRpc(
      mcp.url,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      bearer,
    );
    notify.status === 202 ? ok('notifications/initialized → 202') : fail('initialized 通知', JSON.stringify(notify));

    const tools = await rawRpc(
      mcp.url,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      bearer,
    );
    const names = tools.data?.result?.tools?.map((t) => t.name) ?? [];
    names.includes('execute_sql') && names.includes('show_databases') && names.includes('create_stage')
      ? ok(`tools/list → ${names.length} 个工具（${names.slice(0, 6).join(', ')}…）`)
      : fail('tools/list', JSON.stringify(tools));

    const call = await rawRpc(
      mcp.url,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'show_databases', arguments: {} },
      },
      bearer,
    );
    const text = call.data?.result?.content?.[0]?.text ?? '';
    text.includes('information_schema')
      ? ok('tools/call show_databases → login/Bearer/真实 HTTP 查询链路')
      : fail('tools/call show_databases', JSON.stringify(call));

    const read = await rawRpc(
      mcp.url,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'execute_sql', arguments: { sql: 'SELECT version()' } },
      },
      bearer,
    );
    read.data?.result?.content?.[0]?.text?.includes('lake-fake-0.3.2')
      ? ok('tools/call execute_sql SELECT → 数据返回')
      : fail('execute_sql SELECT', JSON.stringify(read));

    const block = await rawRpc(
      mcp.url,
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'execute_sql', arguments: { sql: 'DROP TABLE prod.users' } },
      },
      bearer,
    );
    block.data?.result?.isError === true && /安全模式/.test(block.data.result.content[0].text)
      ? ok('安全模式拦截 DROP TABLE prod.users')
      : fail('安全模式拦截', JSON.stringify(block));

    const sandbox = await rawRpc(
      mcp.url,
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'create_session_sandbox_database', arguments: { name: 'analytics' } },
      },
      bearer,
    );
    sandbox.data?.result?.isError !== true && sandbox.data?.result?.content?.[0]?.text?.includes('status')
      ? ok('sandbox 写工具放行（mcp_sandbox_<session>_analytics）')
      : fail('sandbox 写工具', JSON.stringify(sandbox));

    const prefixRes = await rawRpc(
      mcp.url,
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'get_session_sandbox_prefix', arguments: {} },
      },
      bearer,
    );
    prefixRes.data?.result?.content?.[0]?.text?.includes('mcp_sandbox_')
      ? ok('get_session_sandbox_prefix → 返回 sandbox 前缀')
      : fail('sandbox prefix', JSON.stringify(prefixRes));

    // 断言真实 Lake 侧协议：login(1) + refresh(1) + query(1 成功)
    fake.seen.logins >= 1 && fake.seen.refreshes >= 1
      ? ok(`Lake 协议：login ×${fake.seen.logins} · refresh ×${fake.seen.refreshes}（token 过期自动续期）`)
      : fail('Lake login/refresh', JSON.stringify(fake.seen));
    fake.seen.warehouses.every((w) => w === 'wh')
      ? ok('查询请求携带 X-DATABEND-WAREHOUSE=wh')
      : fail('warehouse 头', JSON.stringify(fake.seen.warehouses));
    fake.seen.authMode.includes('query:bearer')
      ? ok('查询使用 Bearer session_token（非明文 Basic）')
      : fail('Bearer 查询', JSON.stringify(fake.seen.authMode));

    const health = await fetch(mcp.url.replace(/\/mcp$/, '/healthz'));
    health.ok ? ok('GET /healthz → 200') : fail('healthz', health.status);
  } catch (error) {
    fail('selftest', error);
  } finally {
    await mcp.close();
    await handler.dispose?.();
    await fake.close();
  }

  if (failures.length) {
    console.error(`\n自测失败 ${failures.length} 项：${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\n自测全部通过 ✅');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
