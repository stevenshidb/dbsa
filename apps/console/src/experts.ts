// 专家场景与场景 Agent 定义。
// 说明：Agent9 的 Agent 不支持自定义 system prompt，因此每个专家的「角色设定」以首轮简报注入，
// 正式化时可将同一份内容做成 Skill 包安装到对应 Agent。

const BASE_CONFIG = {
  runtime: { backend: 'pi' },
  memory: { enabled: true, provider: 'mem9', mem9: {} },
  sessionRecall: { enabled: true },
  knowledgeBase: { enabled: true },
  generatedMedia: { enabled: false },
  notion: { enabled: false },
  tools: { managed: [] },
};

const capsOf = (config) => {
  const c = [];
  if (config.memory?.enabled) c.push('客户记忆');
  if (config.sessionRecall?.enabled) c.push('会话召回');
  if (config.knowledgeBase?.enabled) c.push('知识库');
  if (config.generatedMedia?.enabled) c.push('生成媒体');
  if (config.notion?.enabled) c.push('Notion');
  return c;
};

export const EXPERTS = [
  {
    id: 'sales',
    name: '销售场景',
    icon: '💼',
    description: '面向销售团队：商机挖掘、客户沟通建议、报价方向、跟进提醒、话术生成。',
    agents: [
      {
        id: 'agent_sales_expert',
        name: '销售增长助手',
        model: 'DeepSeek-V4-Flash',
        description: '商机分析与客户沟通专家：帮销售快速了解客户、准备沟通话术、规划跟进节奏。',
        config: {
          ...BASE_CONFIG,
          generatedMedia: { enabled: false },
          notion: { enabled: false },
        },
        briefing:
          '你是「销售增长助手」，服务 TiDB 销售团队。\n' +
          '职责：商机挖掘与评估、客户背景调研、首次接触话术、异议应对、报价方向（不给具体数字）、跟进节奏建议。\n' +
          '规则：1) 客户信息不确定时明确说明并建议查证；2) 话术要口语化、可落地；3) 涉及商务条件只给方向；4) 回答中文。',
      },
    ],
  },
  {
    id: 'presales',
    name: '售前场景',
    icon: '🛠️',
    description: '面向售前团队：需求分析、方案设计、竞品对比、POC 准备、方案书/标书编写。',
    agents: [
      {
        id: 'agent_presales_expert',
        name: '售前方案专家',
        model: 'DeepSeek-V4-Flash',
        description: '覆盖售前全流程：从客户需求分析到方案书/标书产出，含迁移路径与 POC 用例设计。',
        config: {
          ...BASE_CONFIG,
          generatedMedia: { enabled: true },
          notion: { enabled: true },
        },
        briefing:
          '你是「售前方案专家」，服务 TiDB 售前工程师。\n' +
          '职责：客户需求分析、TiDB/MySQL 迁移与 HTAP 方案设计、竞品对比、POC 准备、方案书/标书编写。\n' +
          '规则：1) 不确定的信息明确说明并建议查证；2) 方案必须可落地（步骤/材料清单）；3) 涉及报价只给方向；4) 回答中文。',
      },
    ],
  },
  {
    id: 'aftersales',
    name: '售后场景',
    icon: '🔧',
    description: '面向售后与支持团队：故障排查、工单协助、升级建议、知识库检索、操作指引。',
    agents: [
      {
        id: 'agent_aftersales_expert',
        name: '售后支持专家',
        model: 'DeepSeek-V4-Flash',
        description: '一线支持助手：按标准流程排查 TiDB 常见问题，给出可执行的排查步骤与升级建议。',
        config: {
          ...BASE_CONFIG,
          generatedMedia: { enabled: false },
          notion: { enabled: true },
        },
        briefing:
          '你是「售后支持专家」，服务 TiDB 售后与技术支持团队。\n' +
          '职责：故障现象定位、标准排查流程（慢查询、热点、集群状态、日志）、工单信息整理、升级建议、知识库检索。\n' +
          '规则：1) 先收集关键信息再判断（版本、拓扑、复现步骤）；2) 不臆测根因，明确“需进一步采集的信息”；3) 涉及生产变更必须提示人工确认；4) 回答中文。',
      },
    ],
  },
];

export const expertCaps = (agent) => capsOf(agent.config);

/** 新增场景默认模板（便于扩展更多场景后直接编辑）。 */
export const newExpertScenario = (id) => ({
  id,
  name: '新场景',
  icon: '📋',
  description: '',
  agents: [
    {
      id: `agent_${id}`,
      name: '场景助手',
      model: 'DeepSeek-V4-Flash',
      description: '',
      config: JSON.parse(JSON.stringify(BASE_CONFIG)),
      briefing: '你是该场景的专家助手，请围绕场景目标提供专业、可落地的回答。',
    },
  ],
});
