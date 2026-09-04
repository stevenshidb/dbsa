#!/usr/bin/env node
// 脚本化售前演示流程：需求分析 → 方案生成 → 制品 → 跟进任务。
import { loadEnv, requireEnv } from './lib/env.mjs';
import { Agent9Client } from '../packages/client/src/index.js';

loadEnv();

const baseUrl = requireEnv('AGENT9_BASE_URL');
const apiKey = requireEnv('AGENT9_API_KEY', true);
const client = new Agent9Client({ baseUrl, apiKey, projectId: process.env.AGENT9_PROJECT_ID });

const PERSONA = [
  '你是「TiDB 售前助手」，服务 TiDB 售前工程师。',
  '你的职责：理解客户需求、给出 TiDB/MySQL 迁移与 HTAP 方案建议、竞品对比、POC 准备、方案书编写。',
  '规则：1) 不确定的信息明确说明并建议查证；2) 方案必须可落地（给出步骤/材料清单）；3) 涉及报价只给方向不给数字；4) 回答中文。',
].join('\n');

const SCENARIOS = {
  requirement: '客户是一家日订单量百万级的电商平台，目前使用 MySQL 分库分表，遇到大促容量规划困难和跨库 join 问题。请做需求分析：识别关键问题、评估是否适合 TiDB、给出建议的下一步（含需要向客户确认的问题清单）。',
  proposal: '基于上面的需求分析，写一份《TiDB 迁移技术方案》概要，包含：客户背景、现状与痛点、目标架构（TiDB 集群拓扑、与现有分库分表改造的差异）、迁移路径（数据迁移、双写、灰度）、风险与应对。控制在 800 字以内。',
  competitive: '客户在 TiDB 与某云厂商 Aurora/分布式数据库之间做选型。请给出对比维度建议（架构、HTAP、兼容性、运维、成本模型），并指出 TiDB 的优势场景与不适合的场景，保持客观。',
  poc: '客户准备做 POC。请输出一份 POC 方案清单：目标、环境准备（TiDB 集群规格建议）、测试用例（TPC-C/TPC-H/高并发写入/跨域读写）、验收指标、时间线。',
};

async function streamTurn(client, sessionId, text, label) {
  console.log(`\n── ${label} ──`);
  let finalText = '';
  try {
    for await (const ev of client.createTurnStream(sessionId, { type: 'text', text })) {
      if (ev.event === 'operation_step') {
        const s = ev.payload?.status ?? '';
        const mark = s === 'failed' ? '✗' : s === 'running' ? '…' : '✓';
        console.log(`  ${mark} ${ev.payload?.label ?? ev.payload?.operationId ?? ''}`);
      } else if (ev.event === 'assistant_draft') {
        process.stdout.write('\r  ▍' + (ev.payload?.text ?? '').slice(-120));
      } else if (ev.event === 'assistant_message') {
        finalText = ev.payload?.text ?? '';
      } else if (ev.event === 'turn_error') {
        console.log(`\n  ✗ Turn 错误：${ev.payload?.message ?? ''}`);
      } else if (ev.event === 'turn_finished' && ev.payload?.status === 'failed') {
        console.log('\n  ✗ Turn 失败');
      }
    }
  } catch (err) {
    console.log(`  ✗ 请求失败：${err.message}`);
  }
  process.stdout.write('\n');
  if (finalText) console.log(finalText.slice(0, 500) + (finalText.length > 500 ? '…' : ''));
  return finalText;
}

async function main() {
  const scene = process.argv[2];
  if (scene && !SCENARIOS[scene]) {
    console.error(`未知场景：${scene}（可选：requirement | proposal | competitive | poc）`);
    process.exit(1);
  }

  const agents = await client.listAgents();
  const list = agents?.agents ?? agents ?? [];
  const agent = list.find((a) => /售前|TiDB/i.test(`${a.name ?? ''}${a.agentId ?? ''}`)) ?? list[0];
  if (!agent) {
    console.error('未找到 Agent，请先运行 pnpm seed');
    process.exit(1);
  }
  // 解析项目作用域（Turn/会话路由需要 x-agent9-project-id）
  if (!client.projectId) {
    const projects = await client.listProjects();
    const proj = projects?.projects ?? projects ?? [];
    client.projectId = proj[0]?.projectId;
    if (!client.projectId) throw new Error('无法解析项目，请设置 AGENT9_PROJECT_ID');
  }
  const agentId = agent.agentId ?? agent.id;
  console.log(`使用 Agent：${agent.name ?? agentId}（${agentId}）`);

  const session = await client.createSession({ agentId });
  const sessionId = session?.session?.sessionId ?? session?.sessionId;
  console.log(`会话：${sessionId}\n`);

  const first = PERSONA + '\n\n' + (SCENARIOS[scene] ?? SCENARIOS.requirement);
  await streamTurn(client, sessionId, first, '第一轮：' + (scene ?? '需求分析'));

  if (!scene || scene === 'requirement') {
    await streamTurn(client, sessionId, SCENARIOS.proposal, '第二轮：方案生成');
    await streamTurn(client, sessionId, SCENARIOS.poc, '第三轮：POC 准备');
  }

  try {
    const arts = await client.listArtifacts({ limit: 5 });
    const list2 = arts?.artifacts ?? arts ?? [];
    console.log(`\n── 制品区（${list2.length} 项）──`);
    for (const a of list2.slice(0, 5)) {
      console.log(`  ${a.artifactId}  ${a.displayName ?? ''}  ${a.kind ?? ''}  ${a.state ?? ''}`);
    }
  } catch (err) {
    console.log(`\n制品查询不可用：${err.message}`);
  }

  console.log('\n完成。会话 id 可继续在 Console/CLI 中追问。');
}

main().catch((err) => {
  console.error('\n演示失败：', err.message);
  process.exit(1);
});
