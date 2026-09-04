// Mock 模式：不依赖后端，模拟 Agent9 的 TurnStreamEvent 序列与售前场景回复。

export const SCENARIOS = [
  { id: 'requirement', label: '需求分析', prompt: '客户是日订单百万级的电商平台，MySQL 分库分表遇到大促容量规划与跨库 join 问题。做需求分析并给出待确认问题清单。' },
  { id: 'proposal', label: '生成方案', prompt: '基于上面的需求分析，写一份《TiDB 迁移技术方案》概要（背景、痛点、目标架构、迁移路径、风险）。' },
  { id: 'competitive', label: '竞品对比', prompt: '对比 TiDB 与云厂商分布式数据库：架构、HTAP、兼容性、运维、成本模型，客观指出各自的适合场景。' },
  { id: 'poc', label: 'POC 准备', prompt: '为客户输出 POC 方案清单：目标、环境规格、测试用例（TPC-C/TPC-H/高并发）、验收指标、时间线。' },
  { id: 'followup', label: '跟进周报', prompt: '整理本周对该客户的跟进要点：未决问题、下一步建议、需要准备的方案材料。' },
];

export const MOCK_AGENTS = [
  { agentId: 'agent_mock_presales', name: 'TiDB 售前助手', model: 'DeepSeek-V4-Flash', status: 'active', configVersion: 2 },
  { agentId: 'agent_mock_dev', name: 'Dev Agent', model: 'gpt-5.6-luna', status: 'active', configVersion: 1 },
];

const mockSessionsByAgent = new Map();

export function mockSessions(agentId) {
  if (!mockSessionsByAgent.has(agentId)) mockSessionsByAgent.set(agentId, []);
  return mockSessionsByAgent.get(agentId);
}

const ANSWERS = {
  requirement: [
    '## 需求分析\n\n### 现状与痛点\n- 订单与用户表分库分表后，跨库 join / 分布式事务复杂，报表与运营分析依赖独立数仓，链路长、时效差。\n- 大促容量规划被动：分片扩容需停写或双写改造，扩缩容风险高。\n- 运维成本高：分片中间件、数据同步、分片键设计约束业务模型。\n\n### 适配性判断\n适合 TiDB：业务是典型 OLTP + 轻量分析（HTAP）混合负载；MySQL 生态依赖度高。\n\n### 待确认问题\n1. 峰值 QPS 与数据量（含未来 2 年增长）？\n2. 分析查询对时效的要求（实时 vs T+1）？\n3. 是否允许短暂只读窗口做迁移切换？\n4. 现有分片键与跨片事务的分布？',
  ],
  proposal: [
    '## TiDB 迁移技术方案（概要）\n\n### 目标架构\n- 一套 TiDB 集群承载在线交易（TiKV）与实时分析（TiFlash），替换分库分表 + 数仓双链路。\n- 按业务域拆分 Database，配合 Placement Rules 控制副本分布。\n\n### 迁移路径\n1. 全量：Dumpling 导出 + TiDB Lightning 导入，先建影子库校验。\n2. 增量：DM / TiCDC 同步，保持双写灰度。\n3. 切换：按业务域分批灰度，设置回滚预案（保留原分片集群只读）。\n\n### 风险与应对\n- 数据一致性：切换前做行数 + 校验和比对。\n- 性能回退：压测先行，建立基线指标。\n- 团队技能：安排 TiDB 运维培训与演练。',
  ],
  competitive: [
    '## 竞品对比\n\n| 维度 | TiDB | 云厂商 Aurora 类 | 云厂商分布式数据库 |\n| --- | --- | --- | --- |\n| 架构 | Shared-Nothing，存储计算分离 | 共享存储单写多读 | Shared-Nothing / 分片 |\n| HTAP | TiFlash 列存原生 | 只读副本 | 部分支持 |\n| MySQL 兼容 | 高（协议/语法） | 高（但分片需改造） | 中 |\n| 扩展 | 在线扩缩容 | 垂直为主 | 水平为主 |\n| 成本模型 | 自管/云托管两档 | 按实例 | 按节点/分片 |\n\n### 建议\n- 强 HTAP、多写多活、开源可控 → TiDB。\n- 纯单机低延迟小规模 → Aurora 类更省心。\n- 对比基准数据必须来自官方文档或实测，避免引用营销数字。',
  ],
  poc: [
    '## POC 方案清单\n\n### 目标\n验证 TiDB 在目标负载下的性能、兼容性与运维可行性。\n\n### 环境规格（建议）\n- 3 节点 TiKV（8C/32G）+ 1 节点 TiFlash（8C/32G）+ PD/TiDB 各 2。\n- 监控：Prometheus + Grafana。\n\n### 测试用例\n1. TPC-C 基准（200~500 warehouses）。\n2. TPC-H 1G/10G 分析查询。\n3. 高并发写入（热点与均匀分布）。\n4. 在线 DDL 与扩缩容演练。\n5. 故障演练（kill -9 一个 TiKV 节点）。\n\n### 验收指标\n- 事务延迟 P99 < 20ms；分析查询满足业务 SLA；数据一致性零丢失（配合 DM/CDC 校验）。',
  ],
  followup: [
    '## 跟进周报\n\n### 本周进展\n- 完成需求分析，确认客户核心痛点是分库分表改造与实时分析链路。\n\n### 未决问题\n- 客户尚未提供峰值 QPS 与数据量基线。\n\n### 下一步建议\n1. 约技术交流会，演示 HTAP 场景。\n2. 提供 POC 环境规格与时间线。\n3. 准备《MySQL→TiDB 迁移最佳实践》材料。\n\n### 需要准备的方案材料\n- 迁移方案概要、POC 用例清单、案例参考（同类电商客户）。',
  ],
};

const OPS = {
  requirement: [
    { label: '召回客户历史记忆', status: 'succeeded' },
    { label: '检索 TiDB 迁移知识库', status: 'succeeded' },
    { label: '分析需求并生成问题清单', status: 'succeeded' },
  ],
  proposal: [
    { label: '读取需求分析上下文', status: 'succeeded' },
    { label: '检索迁移方案模板', status: 'succeeded' },
    { label: '生成方案文档', status: 'succeeded' },
  ],
  competitive: [
    { label: '检索竞品对比资料', status: 'succeeded' },
    { label: '整理对比矩阵', status: 'succeeded' },
  ],
  poc: [
    { label: '检索 POC 最佳实践', status: 'succeeded' },
    { label: '生成 POC 用例清单', status: 'succeeded' },
  ],
  followup: [
    { label: '召回本周会话记录', status: 'succeeded' },
    { label: '生成跟进周报', status: 'succeeded' },
  ],
};

export class MockSession {
  constructor(public id = `sess_mock_${Math.random().toString(36).slice(2, 8)}`) {}

  async *turns(text, sceneId) {
    const id = SCENARIOS.find((s) => s.id === sceneId) ? sceneId : 'requirement';
    const turnId = `turn_mock_${Math.random().toString(36).slice(2, 8)}`;
    const now = () => new Date().toISOString();
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    let seq = 0;

    yield { event: 'turn_started', turnId, sessionId: this.id, seq: seq++, createdAt: now(), payload: {} };
    for (const op of OPS[id]) {
      await delay(350);
      yield { event: 'operation_step', turnId, sessionId: this.id, seq: seq++, createdAt: now(), payload: { ...op, operationId: `op_mock_${seq}` } };
    }
    const answer = ANSWERS[id][0];
    const withAttachments = text.startsWith('【附件】') ? '\n\n（已随本次提问携带附件，模型将结合附件内容回答。）' : '';
    await delay(300);
    const chunks = answer.match(/.{1,40}/gs) ?? [];
    let draft = '';
    for (const chunk of chunks) {
      await delay(18);
      draft += chunk;
      yield { event: 'assistant_draft', turnId, sessionId: this.id, seq: seq++, createdAt: now(), payload: { text: draft } };
    }
    const messageId = `msg_mock_${Math.random().toString(36).slice(2, 8)}`;
    yield { event: 'assistant_message', turnId, sessionId: this.id, seq: seq++, createdAt: now(), payload: { messageId, text: answer + withAttachments } };
    yield { event: 'turn_finished', turnId, sessionId: this.id, seq: seq++, createdAt: now(), payload: { status: 'succeeded' } };
  }
}
