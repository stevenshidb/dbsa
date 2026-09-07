#!/usr/bin/env node
// tidbsa 命令行：setup / chat / demo / list
import { Agent9Client, Agent9ApiError } from '../../packages/client/src/index.js';
import { loadEnv, requireEnv } from '../../scripts/lib/env.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

loadEnv();

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(`tidbsa —— TiDB 售前 Agent 命令行

用法：
  tidbsa doctor             检查与 Agent9 的连通性（livez/readyz/项目/鉴权）
  tidbsa setup                创建售前 Agent（同 pnpm seed）
  tidbsa chat "<问题>"        新建会话并提问（自动带角色设定）
  tidbsa chat --once "<问题>" 使用上次会话（不重设角色）
  tidbsa demo [scene]         脚本化流程（requirement|proposal|competitive|poc）
  tidbsa list <agents|sessions|artifacts|schedulers>
  tidbsa mcp databend connect <https://…/mcp> [--agent <agentId>] [--bearer <token>]
                               注册/激活/挂载 Databend MCP 数据源（路径 A）
  tidbsa mcp lake connect <https://…/mcp> [--agent <agentId>] [--bearer <token>]
                               注册/激活/挂载 TiDB Cloud Lake MCP 数据源（路径 A）

需要环境变量：AGENT9_BASE_URL、AGENT9_API_KEY（可放 .env）
`);
  process.exit(0);
}

const baseUrl = requireEnv('AGENT9_BASE_URL');
const apiKey = requireEnv('AGENT9_API_KEY', true);
const client = new Agent9Client({ baseUrl, apiKey, projectId: process.env.AGENT9_PROJECT_ID });

const ROOT = dirname(fileURLToPath(import.meta.url));
const PERSONA = [
  '你是「TiDB 售前助手」，服务 TiDB 售前工程师。',
  '职责：客户需求分析、TiDB/MySQL 迁移与 HTAP 方案建议、竞品对比、POC 准备、方案书编写。',
  '规则：1) 不确定的信息明确说明并建议查证；2) 方案必须可落地；3) 涉及报价只给方向；4) 回答中文。',
].join('\n');

async function pickAgent() {
  const res = await client.listAgents();
  const list = res?.agents ?? res ?? [];
  const agent = list.find((a) => /售前|TiDB/i.test(`${a.name ?? ''}${a.agentId ?? ''}`)) ?? list[0];
  if (!agent) {
    console.error('未找到 Agent，请先运行 pnpm seed');
    process.exit(1);
  }
  return agent.agentId ?? agent.id;
}

async function ensureProject() {
  if (client.projectId) return client.projectId;
  const res = await client.listProjects();
  const list = res?.projects ?? res ?? [];
  if (!list[0]?.projectId) throw new Error('无法解析项目，请设置 AGENT9_PROJECT_ID');
  client.projectId = list[0].projectId;
  return client.projectId;
}

async function stream(sessionId, text, label = '') {
  if (label) console.log(`\n[${label}]`);
  let final = '';
  try {
    for await (const ev of client.createTurnStream(sessionId, { type: 'text', text })) {
      if (ev.event === 'operation_step') {
        console.log(`  ${ev.payload?.label ?? ''}`);
      } else if (ev.event === 'assistant_message') {
        final = ev.payload?.text ?? '';
      } else if (ev.event === 'turn_error') {
        console.log(`  ✗ ${ev.payload?.message ?? ''}`);
      }
    }
  } catch (err) {
    console.error(`  ✗ ${err.message}`);
  }
  if (final) console.log('\n' + final);
  return final;
}

async function main() {
  if (cmd === 'mcp') {
    const group = args[0];
    const action = args[1];
    const flag = (name, fallback = null) => {
      const i = args.indexOf(name);
      return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
    };
    if (group === 'databend' && action === 'connect') {
      const { connectDatabendMcp } = await import('../../scripts/lib/mcp-databend.mjs');
      const endpointUrl = args[2];
      const agentId = flag('--agent') ?? (await pickAgent());
      const bearer = flag('--bearer', '');
      const displayName = flag('--name', 'Databend 数据源');
      if (!endpointUrl || !/^https:\/\//i.test(endpointUrl)) {
        console.error('用法：tidbsa mcp databend connect <https://…/mcp> [--agent <agentId>] [--bearer <token>]');
        process.exit(1);
      }
      await ensureProject();
      const result = await connectDatabendMcp(client, {
        endpointUrl,
        bearer,
        agentId,
        displayName,
      });
      console.log('\n完成：');
      console.log(`  MCP Server: ${result.serverId}`);
      console.log(`  Agent     : ${result.agentId}`);
      console.log('现在可以在该 Agent 的对话中直接使用 execute_sql/show_databases 等工具。');
      return;
    }
    if (group === 'lake' && action === 'connect') {
      const { connectLakeMcp } = await import('../../scripts/lib/mcp-lake.mjs');
      const endpointUrl = args[2];
      const agentId = flag('--agent') ?? (await pickAgent());
      const bearer = flag('--bearer', '');
      const displayName = flag('--name', 'TiDB Cloud Lake 数据源');
      if (!endpointUrl || !/^https:\/\//i.test(endpointUrl)) {
        console.error('用法：tidbsa mcp lake connect <https://…/mcp> [--agent <agentId>] [--bearer <token>]');
        process.exit(1);
      }
      await ensureProject();
      const result = await connectLakeMcp(client, {
        endpointUrl,
        bearer,
        agentId,
        displayName,
      });
      console.log('\n完成：');
      console.log(`  MCP Server: ${result.serverId}`);
      console.log(`  Agent     : ${result.agentId}`);
      console.log('现在可以在该 Agent 的对话中直接使用 execute_sql/show_databases 等工具。');
      return;
    }
    console.error('未知 mcp 子命令。用法：tidbsa mcp databend|lake connect <endpoint> [--agent id] [--bearer token]');
    process.exit(1);
  }

  if (cmd === 'setup') {
    const { default: seed } = await import('../../scripts/seed.mjs');
    await seed();
    return;
  }

  if (cmd === 'doctor') {
    console.log(`Agent9 地址：${baseUrl || '（未配置，走相对路径）'}\n`);
    const step = async (label, fn) => {
      try {
        const res = await fn();
        console.log(`  ✓ ${label}`);
        return res;
      } catch (err) {
        console.log(`  ✗ ${label}：${err.message}`);
        return null;
      }
    };
    await step('/livez', () => client.livez());
    await step('/readyz', () => client.readyz());
    const projects = await step('列出项目', () => client.listProjects());
    const proj = projects?.projects ?? projects ?? [];
    if (proj.length) {
      console.log(`    → 当前可用项目：${proj.map((p) => p.projectId).join(', ')}`);
      if (!client.projectId) client.projectId = proj[0].projectId;
    }
    const agents = await step('列出 Agent', () => client.listAgents());
    const list = agents?.agents ?? agents ?? [];
    if (list.length) console.log(`    → ${list.length} 个 Agent：${list.map((a) => a.name ?? a.agentId).join(', ')}`);
    const models = await step('模型目录', () => client.listAgentModels());
    if (models?.models) console.log(`    → 可用模型：${models.models.map((m) => m.model ?? m.id).join(', ')}`);
    return;
  }

  if (cmd === 'chat') {
    const once = args[0] === '--once';
    const text = (once ? args.slice(1) : args).join(' ');
    if (!text) {
      console.error('请输入问题：tidbsa chat "..."');
      process.exit(1);
    }
    const agentId = await pickAgent();
    await ensureProject();
    const session = await client.createSession({ agentId });
    const sessionId = session?.session?.sessionId ?? session?.sessionId;
    await stream(sessionId, once ? text : `${PERSONA}\n\n${text}`, '提问');
    console.log(`\n会话：${sessionId}`);
    return;
  }

  if (cmd === 'demo') {
    const { default: demo } = await import('../../scripts/demo.mjs');
    const scene = args[0];
    process.argv = [process.argv[0], process.argv[1], scene].filter(Boolean);
    await demo();
    return;
  }

  if (cmd === 'list') {
    await ensureProject();
    const what = args[0] ?? 'agents';
    const res = await client[`list${what[0].toUpperCase()}${what.slice(1)}`]?.({ limit: 20 });
    const list = res?.agents ?? res?.sessions ?? res?.artifacts ?? res?.schedulers ?? res ?? [];
    for (const item of list.slice(0, 20)) {
      const id = item.agentId ?? item.sessionId ?? item.artifactId ?? item.schedulerId ?? item.id;
      console.log(`${id}  ${item.name ?? item.displayName ?? item.title ?? ''}`);
    }
    return;
  }

  console.error(`未知命令：${cmd}（tidbsa help 查看用法）`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
