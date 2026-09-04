#!/usr/bin/env node
// 自测：起一个假 Databend HTTP 服务 + 真实 MCP 桥，验证 initialize / tools/list / tools/call / 安全模式。

import { createServer } from 'node:http';
import { createDatabendHandler } from '../src/handler.mjs';
import { startMcpServer } from '../src/server.mjs';

const failures = [];
const ok = (label) => console.log(`  ✓ ${label}`);
const fail = (label, error) => {
  failures.push(label);
  console.error(`  ✗ ${label}：${error?.stack || error}`);
};

async function startFakeDatabend() {
  const seen = [];
  const srv = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    let sql = '';
    try {
      sql = JSON.parse(body)?.sql ?? '';
    } catch {
      // ignore
    }
    seen.push(sql);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (/SELECT version\(\)/i.test(sql)) {
      res.end(JSON.stringify({ schema: [{ name: 'version' }], data: [['fake-1.2.3']] }));
      return;
    }
    if (/SHOW DATABASES/i.test(sql)) {
      res.end(
        JSON.stringify({
          schema: [{ name: 'Database' }],
          data: [['default'], ['information_schema']],
        }),
      );
      return;
    }
    res.end(JSON.stringify({ schema: [{ name: 'ok' }], data: [[1]] }));
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
  console.log('== Databend MCP Bridge 自测 ==\n');
  const fake = await startFakeDatabend();
  const dsn = `databend://u:p@127.0.0.1:${fake.port}/default?warehouse=default&sslmode=disable`;
  const bearer = 'test-bearer-123';
  const handler = createDatabendHandler({ dsn, safeMode: true, timeoutSecs: 10 });
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
    init.status === 200 && init.data?.result?.serverInfo?.name
      ? ok(`initialize → ${init.data.result.serverInfo.name} @ ${init.data.result.protocolVersion}`)
      : fail('initialize', JSON.stringify(init));

    const notify = await rawRpc(
      mcp.url,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      bearer,
    );
    notify.status === 202
      ? ok('notifications/initialized → 202')
      : fail('initialized 通知', JSON.stringify(notify));

    const tools = await rawRpc(
      mcp.url,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      bearer,
    );
    const names = tools.data?.result?.tools?.map((t) => t.name) ?? [];
    names.includes('execute_sql') && names.includes('show_databases')
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
      ? ok('tools/call show_databases → 真实 HTTP 查询链路')
      : fail('tools/call show_databases', JSON.stringify(call));

    const block = await rawRpc(
      mcp.url,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'execute_sql', arguments: { sql: 'DROP TABLE prod.users' } },
      },
      bearer,
    );
    block.data?.result?.isError === true && /安全模式/.test(block.data.result.content[0].text)
      ? ok('安全模式拦截 DROP TABLE prod.users')
      : fail('安全模式拦截', JSON.stringify(block));

    const read = await rawRpc(
      mcp.url,
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'execute_sql', arguments: { sql: 'SELECT version()' } },
      },
      bearer,
    );
    read.data?.result?.content?.[0]?.text?.includes('fake-1.2.3')
      ? ok('tools/call execute_sql SELECT → 数据返回')
      : fail('execute_sql SELECT', JSON.stringify(read));

    const health = await fetch(mcp.url.replace(/\/mcp$/, '/healthz'));
    health.ok ? ok('GET /healthz → 200') : fail('healthz', health.status);
  } catch (error) {
    fail('selftest', error);
  } finally {
    await mcp.close();
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
