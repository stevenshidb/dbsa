#!/usr/bin/env node
// 一键初始化：创建「TiDB 售前助手」Agent（全能力配置）→ 创建客户会话 → 创建跟进定时任务。
// 用法：pnpm seed   （需要 AGENT9_BASE_URL / AGENT9_API_KEY，.env 或环境变量）
import { loadEnv, requireEnv } from './lib/env.mjs';
import { Agent9Client } from '../packages/client/src/index.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

loadEnv();

const baseUrl = requireEnv('AGENT9_BASE_URL');
const apiKey = requireEnv('AGENT9_API_KEY', true);
const projectId = process.env.AGENT9_PROJECT_ID;
const client = new Agent9Client({ baseUrl, apiKey, projectId });

const root = dirname(fileURLToPath(import.meta.url));
const agentBody = JSON.parse(
  readFileSync(resolve(root, '../config/agent-tidb-presales.json'), 'utf8'),
);

async function main() {
  console.log('== tidbsa 初始化 ==\n');

  // 0) 连通性诊断：先把「连不上」和「服务端报错」区分开
  console.log(`检查 Agent9：${baseUrl || '（未配置地址，将走相对路径）'}`);
  try {
    const l = await client.livez();
    console.log(`  /livez  OK  ${JSON.stringify(l ?? '')}`);
  } catch (err) {
    console.error(`  ✗ /livez 失败：${err.message}`);
    console.error(`
请检查：
  1) Agent9 服务是否已启动（docker compose 请先确认 migrate 与 agent9 容器均为 healthy）
  2) AGENT9_BASE_URL 是否正确（本地 docker compose 为 http://localhost:5172）
  3) 本机能否访问：curl ${baseUrl || 'http://localhost:5172'}/livez
  4) Apple Silicon 上 docker compose 的 agent9 是 amd64 模拟，启动较慢，请耐心等待 ready`);
    process.exit(1);
  }

  // 1) 项目作用域
  let project = null;
  try {
    const res = await client.listProjects();
    const projects = res?.projects ?? res ?? [];
    project = projects.find((p) => p.projectId === projectId) ?? projects[0];
    if (!project) throw new Error('当前 API Key 可见的工作区下没有项目');
    client.projectId = project.projectId;
    console.log(`项目：${project.projectId} (${project.name ?? 'default'})`);
  } catch (err) {
    if (err instanceof Agent9ApiError && err.code === 'connection_error') {
      console.error(`✗ 无法连接 Agent9：${err.message}`);
      process.exit(1);
    }
    console.warn(`获取项目失败：${err.message}（继续尝试，部分路由可能 400）`);
  }

  // 2) 创建 Agent（先带记忆凭据；若 provision 失败则降级为不绑定）
  const stableKey = (body) =>
    `tidbsa-seed-${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 24)}`;
  let agent = null;
  try {
    agent = await client.createAgent(agentBody, { idempotencyKey: stableKey(agentBody) });
    console.log(`Agent 已创建：${agent.agent?.agentId ?? agent.agentId ?? '(见响应)'}（${agentBody.name}）`);
  } catch (err) {
    console.warn(`带记忆凭据创建失败（${err.message}），降级为不带 memoryCredential 重试...`);
    const { memoryCredential, ...withoutCredential } = agentBody;
    agent = await client.createAgent(withoutCredential, {
      idempotencyKey: stableKey(withoutCredential),
    });
    console.log(`Agent 已创建（无记忆凭据）：${agent.agent?.agentId ?? agent.agentId}`);
  }
  const agentId = agent?.agent?.agentId ?? agent?.agentId;

  // 3) 创建示例客户会话
  let session = null;
  try {
    session = await client.createSession({ agentId });
    const sid = session?.session?.sessionId ?? session?.sessionId;
    if (sid) {
      await client.renameSession(sid, '示例客户：某电商平台 MySQL→TiDB 迁移咨询').catch(() => {});
    }
    console.log(`客户会话已创建：${sid}`);
  } catch (err) {
    console.warn(`创建会话失败：${err.message}`);
  }

  // 4) 创建「每周客户跟进」定时任务（cron：每周一 09:00 Asia/Shanghai，新开会话）
  try {
    const scheduler = await client.createScheduler({
      title: '示例客户每周跟进',
      prompt:
        '这是对示例客户的每周例行跟进。回顾该客户在 TiDB 迁移咨询上的进展，整理本周跟进要点：' +
        '1) 客户最新关注点与未决问题；2) 建议的下一步（技术交流/POC 阶段/商务）；3) 需要准备的方案材料。' +
        '输出一份简洁的跟进周报。',
      agentId,
      schedule: { kind: 'cron', cronExpr: '0 9 * * 1', timezone: 'Asia/Shanghai' },
      delivery: { target: 'new_session' },
    });
    console.log(`跟进定时任务已创建：${scheduler?.scheduler?.schedulerId ?? scheduler?.schedulerId}`);
  } catch (err) {
    console.warn(`创建定时任务失败：${err.message}（可能需要更高权限，不影响 Agent/会话）`);
  }

  console.log('\n完成。下一步：');
  console.log(`  pnpm demo                       # 跑一遍脚本化售前流程`);
  console.log(`  pnpm cli chat "写一份 TiDB 迁移方案概要"  # 命令行问答`);
  console.log(`  pnpm console                    # Web Demo（配置 API Key 后切 Live 模式）`);
  if (agentId) console.log(`\nAgentId: ${agentId}`);
}

main().catch((err) => {
  console.error('\n初始化失败：', err.message);
  process.exit(1);
});
