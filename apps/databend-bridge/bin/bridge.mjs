#!/usr/bin/env node
// 启动 Databend → MCP(streamable HTTP) 桥。
// 用法：pnpm databend:bridge   （读取 .env / 环境变量）

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../../../scripts/lib/env.mjs';
import { readConfig, summarizeDsn } from '../src/config.mjs';
import { createDatabendHandler } from '../src/handler.mjs';
import { startMcpServer, randomBearer } from '../src/server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
loadEnv(resolve(root, '.env'));

const config = readConfig();
if (!config.dsn) {
  console.error(
    '缺少 DATABEND_DSN。请先在 .env（或环境变量）配置：\n' +
      '  DATABEND_DSN=databend://user:password@host:443/default?warehouse=default\n' +
      '  DATABEND_MCP_SAFE_MODE=true\n' +
      '  DATABEND_BRIDGE_BEARER=<可选，对外暴露时强烈建议设置>',
  );
  process.exit(1);
}

const summary = summarizeDsn(config.dsn);
const handler = createDatabendHandler({
  dsn: config.dsn,
  safeMode: config.safeMode,
  timeoutSecs: config.queryTimeoutSecs,
  maxRows: config.maxRows,
});

if (config.bearer === 'auto') config.bearer = randomBearer();

const server = await startMcpServer({
  handler,
  bearer: config.bearer,
  bindHost: config.bindHost,
  bindPort: config.bindPort,
  mcpPath: config.mcpPath,
});

console.log('\n== Databend MCP Bridge 已启动 ==');
console.log(`  MCP 端点   : ${server.url}`);
console.log(`  Databend   : ${summary?.host ?? '(解析失败)'} / ${summary?.database ?? ''}`);
console.log(`  用户       : ${summary?.user ? summary.user : '(DSN 内)'}`);
console.log(`  安全模式   : ${config.safeMode ? 'ON（只读 + sandbox 前缀写）' : 'OFF（允许写）'}`);
console.log(`  Bearer 鉴权: ${config.bearer ? (config.bearer === 'auto' ? `自动生成 → ${config.bearer}` : 'ON') : 'OFF（仅限内网）'}`);
console.log(`  健康检查   : ${server.url.replace(/\/mcp$/, '')}/healthz`);
console.log('\n提示：Agent9 注册要求 https:// 公网端点。内网联调可直接使用本地址；对外部署请经 TLS 反向代理。');

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
