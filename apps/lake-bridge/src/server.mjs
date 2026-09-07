// 极简 MCP Streamable HTTP（stateless JSON-RPC）服务器。
// 与 Agent9 同款 @modelcontextprotocol/client@2.0.0 已实测互通（legacy initialize / tools/list / tools/call）。

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const SUPPORTED_PROTOCOLS = new Set([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
]);

const DEFAULT_PROTOCOL = '2025-06-18';
const MAX_BODY_BYTES = 1024 * 1024;

function jsonResponse(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(payload === undefined ? '' : JSON.stringify(payload));
}

function errorEnvelope(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export async function startMcpServer({
  handler,
  bearer = '',
  bindHost = '127.0.0.1',
  bindPort = 8002,
  mcpPath = '/mcp',
  serverName = 'tidbsa-lake-bridge',
  instructions = 'TiDB Cloud Lake 数据源桥。安全模式默认开启：只读查询可直接执行；写操作仅允许命中 sandbox 前缀对象。',
  logger = console,
} = {}) {
  const normalizedPath = mcpPath.startsWith('/') ? mcpPath : `/${mcpPath}`;
  const safeEqual = (a, b) => {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  };
  const authorized = (req) => {
    if (!bearer) return true;
    const header = req.headers.authorization || req.headers['x-api-key'] || '';
    return header.startsWith('Bearer ') && safeEqual(header.slice(7).trim(), bearer);
  };

  const dispatch = async (msg) => {
    if (!msg || typeof msg !== 'object') return null;
    const { id, method, params } = msg;
    if (id === undefined) return { notify: true };
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'initialize') {
      const offered = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.has(offered) ? offered : DEFAULT_PROTOCOL;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: serverName, version: '0.1.0' },
          instructions,
        },
      };
    }
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: handler.tools } };
    }
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      const result = await handler.exec(name, args);
      return { jsonrpc: '2.0', id, result };
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  };

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname === '/healthz' && req.method === 'GET') {
        jsonResponse(res, 200, { status: 'ok', mcpPath: normalizedPath, bearerAuth: Boolean(bearer) });
        return;
      }
      if (url.pathname !== normalizedPath) {
        jsonResponse(res, 404, errorEnvelope(null, -32000, `Not found: ${url.pathname}`));
        return;
      }
      if (!authorized(req)) {
        jsonResponse(res, 401, errorEnvelope(null, -32000, 'Unauthorized'), {
          'www-authenticate': 'Bearer',
        });
        return;
      }
      if (req.method === 'GET') {
        // 本桥为 JSON-only stateless；返回 405 让新版 SDK 客户端不再等待 SSE。
        jsonResponse(res, 405, errorEnvelope(null, -32000, 'SSE not supported; use JSON POST'));
        return;
      }
      if (req.method === 'DELETE') {
        jsonResponse(res, 200, {});
        return;
      }
      if (req.method !== 'POST') {
        jsonResponse(res, 405, errorEnvelope(null, -32000, 'Method not allowed'));
        return;
      }

      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          jsonResponse(res, 413, errorEnvelope(null, -32000, 'Request body too large'));
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString('utf8').trim();
      let parsed;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch {
        jsonResponse(res, 400, errorEnvelope(null, -32700, 'Parse error'));
        return;
      }
      const messages = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      const requests = messages.filter((m) => m && m.id !== undefined);
      if (requests.length === 0) {
        // notifications（含 notifications/initialized）只确认，不返回 body。
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end();
        return;
      }
      const outputs = [];
      for (const message of messages) {
        const out = await dispatch(message);
        if (out && !out.notify) outputs.push(out);
      }
      jsonResponse(res, 200, outputs.length === 1 ? outputs[0] : outputs);
    } catch (error) {
      logger.error?.('[lake-bridge] unhandled:', error);
      if (!res.headersSent) {
        jsonResponse(res, 500, errorEnvelope(null, -32603, 'Internal error'));
      } else {
        res.destroy();
      }
    }
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(bindPort, bindHost, resolve);
  });

  const address = httpServer.address();
  const actualPort = typeof address === 'object' && address ? address.port : bindPort;
  const base = `http://${bindHost === '0.0.0.0' ? 'localhost' : bindHost}:${actualPort}`;

  return {
    url: `${base}${normalizedPath}`,
    port: actualPort,
    close: () =>
      new Promise((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      }),
  };
}

export function randomBearer() {
  return `tl_${randomBytes(18).toString('base64url')}`;
}
