// 把 MCP tools/call 映射到 TiDB Cloud Lake SQL；结果统一为 text（Agent9 当前只消费 text/link）。

import { createLakeQueryClient, parseDsn } from './lake-http.mjs';
import {
  checkSqlSafety,
  newSessionId,
  sandboxPrefix,
} from './safety.mjs';
import { TOOL_CATALOG } from './catalog.mjs';

const quoteIdent = (name) =>
  String(name ?? '')
    .trim()
    .replace(/`/g, '``');

const safeIdent = (name) => {
  const clean = quoteIdent(name);
  if (!clean || /[^\w.`]/.test(clean.replace(/`/g, ''))) {
    throw new Error(`非法的对象名：${name}`);
  }
  return clean.includes('.') ? clean : `\`${clean}\``;
};

const payloadText = (payload) => JSON.stringify(payload, null, 2);

function successResult(payload) {
  return { content: [{ type: 'text', text: payloadText(payload) }], isError: false };
}

function failureResult(error, extra = {}) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: payloadText({ status: 'error', message, ...extra }) }],
    isError: true,
  };
}

function rowsPayload(sql, result) {
  const obj = {
    status: 'success',
    sql,
    columns: result.columns,
    row_count: result.count,
    truncated: result.truncated,
    data: result.rows,
  };
  if (result.truncated) {
    obj.notice = `结果超过 ${result.count} 行已截断，请用 LIMIT 或聚合缩小结果集`;
  }
  return obj;
}

export function createLakeHandler({
  dsn,
  safeMode = true,
  timeoutSecs = 300,
  maxRows = 200,
  sessionId = newSessionId(),
  query = null,
  logger = console,
} = {}) {
  const client = (() => {
    if (query) {
      return {
        run: (sql) =>
          query(sql).then((r) => ({
            columns: r?.columns ?? [],
            rows: r?.rows ?? [],
            count: r?.rows?.length ?? 0,
            truncated: false,
          })),
      };
    }
    if (!dsn) throw new Error('缺少 LAKE_DSN（或使用 --mock 运行自测）');
    const lake = createLakeQueryClient({ dsn, timeoutSecs, maxRows, logger });
    return {
      run: (sql) => lake.run(sql),
      dispose: () => lake.dispose(),
    };
  })();

  const prefix = sandboxPrefix(sessionId);
  const run = async (sql, opts = {}) => {
    const verdict = checkSqlSafety(sql, { safeMode, prefix });
    if (!verdict.allowed) throw new Error(verdict.reason);
    const result = await client.run(sql);
    return opts.raw ? result : rowsPayload(sql, result);
  };

  const describe = async (table, database) => {
    const qualified = database ? `${safeIdent(database)}.${safeIdent(table)}` : safeIdent(table);
    return run(`DESCRIBE TABLE ${qualified}`);
  };

  const sandboxPayload = () => ({
    status: 'success',
    session_id: sessionId,
    prefix,
    example_database: `${prefix}mydb`,
    example_table: `${prefix}mydb.mytable`,
  });

  const exec = async (name, args = {}) => {
    try {
      switch (name) {
        case 'execute_sql':
          return successResult(await run(String(args.sql ?? '')));
        case 'execute_multi_sql': {
          const sqls = Array.isArray(args.sqls) ? args.sqls : [];
          const results = [];
          for (const sql of sqls) results.push(await run(String(sql ?? '')));
          return successResult({ status: 'success', results });
        }
        case 'show_databases':
          return successResult(await run('SHOW DATABASES'));
        case 'show_tables': {
          const database = args.database ? safeIdent(args.database) : null;
          const filter = args.filter ? String(args.filter) : null;
          let sql = 'SHOW TABLES';
          if (database) sql += ` FROM ${database}`;
          if (filter) sql += ` WHERE ${filter}`;
          return successResult(await run(sql));
        }
        case 'show_functions': {
          const filter = args.filter ? String(args.filter) : null;
          return successResult(await run(filter ? `SHOW FUNCTIONS WHERE ${filter}` : 'SHOW FUNCTIONS'));
        }
        case 'describe_table':
          return successResult(await describe(String(args.table ?? ''), args.database || null));
        case 'show_stages':
          return successResult(await run('SHOW STAGES'));
        case 'list_stage_files': {
          let stage = String(args.stage_name ?? '');
          if (!stage.startsWith('@')) stage = `@${stage}`;
          const path = args.path ? String(args.path).replace(/^\/+|\/+$/g, '') : '';
          return successResult(await run(`LIST ${stage}${path ? `/${path}` : ''}`));
        }
        case 'show_connections':
          return successResult(await run('SHOW CONNECTIONS'));
        case 'get_session_sandbox_prefix':
          return successResult(sandboxPayload());
        case 'list_session_sandbox_databases':
          return successResult(await run(`SHOW DATABASES LIKE '${prefix.replace(/'/g, "''")}%'`));
        case 'create_session_sandbox_database': {
          const suffix = String(args.name ?? '');
          if (!/^\w+$/.test(suffix)) throw new Error('无效的 sandbox 数据库名');
          return successResult(await run(`CREATE DATABASE IF NOT EXISTS ${safeIdent(prefix + suffix)}`));
        }
        case 'create_stage': {
          const name = String(args.name ?? '');
          const url = String(args.url ?? '');
          if (!name || !url) throw new Error('create_stage 需要 name 与 url');
          const parts = [`CREATE STAGE ${safeIdent(name)}`, `URL = '${url.replace(/'/g, "''")}'`];
          if (args.connection_name) parts.push(`CONNECTION = (CONNECTION_NAME = '${String(args.connection_name).replace(/'/g, "''")}')`);
          return successResult(await run(parts.join(' ')));
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return failureResult(error);
    }
  };

  return {
    tools: TOOL_CATALOG,
    exec,
    sessionId,
    prefix,
    dispose: () => client.dispose?.(),
  };
}

export { parseDsn };
