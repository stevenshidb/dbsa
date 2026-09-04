// 暴露给 Agent 的工具目录。输入 Schema 使用 JSON Schema，Agent9 激活时按此冻结。

const optionalString = { type: ['string', 'null'] };

export const TOOL_CATALOG = [
  {
    name: 'execute_sql',
    title: 'Execute SQL (read-only under safe mode)',
    description:
      'Execute a single SQL statement against Databend. With DATABEND_MCP_SAFE_MODE=true, only SELECT/SHOW/DESCRIBE/EXPLAIN/LIST and sandbox-prefixed writes are allowed.',
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string', description: 'SQL statement to execute' } },
      required: ['sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'execute_multi_sql',
    title: 'Execute multiple SQL statements',
    description: 'Run multiple SQL statements sequentially; each is checked by safe mode.',
    inputSchema: {
      type: 'object',
      properties: {
        sqls: { type: 'array', items: { type: 'string' }, description: 'SQL statements' },
      },
      required: ['sqls'],
      additionalProperties: false,
    },
  },
  {
    name: 'show_databases',
    title: 'List databases',
    description: 'List available Databend databases.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'show_tables',
    title: 'List tables',
    description: 'List tables in a database, optionally filtered.',
    inputSchema: {
      type: 'object',
      properties: {
        database: { ...optionalString, description: 'Database name' },
        filter: { ...optionalString, description: 'SQL condition, e.g. `name like \'test%\'`' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'show_functions',
    title: 'List functions',
    description: 'List Databend functions, optionally filtered.',
    inputSchema: {
      type: 'object',
      properties: { filter: { ...optionalString, description: 'SQL condition' } },
      additionalProperties: false,
    },
  },
  {
    name: 'describe_table',
    title: 'Describe table schema',
    description: 'Show the schema of a Databend table.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name' },
        database: { ...optionalString, description: 'Optional database name' },
      },
      required: ['table'],
      additionalProperties: false,
    },
  },
  {
    name: 'show_stages',
    title: 'List stages',
    description: 'List available Databend stages.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_stage_files',
    title: 'List files in a stage',
    description: 'List files under a Databend stage.',
    inputSchema: {
      type: 'object',
      properties: {
        stage_name: { type: 'string', description: 'Stage name (with or without @ prefix)' },
        path: { ...optionalString, description: 'Optional path under the stage' },
      },
      required: ['stage_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'show_connections',
    title: 'List connections',
    description: 'List Databend connections.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_session_sandbox_prefix',
    title: 'Get session sandbox prefix',
    description: 'Return the current bridge sandbox prefix for writable objects.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_session_sandbox_databases',
    title: 'List sandbox databases',
    description: 'List databases owned by the current sandbox session.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_session_sandbox_database',
    title: 'Create sandbox database',
    description: 'Create a writable database under the current session sandbox.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Database suffix' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_stage',
    title: 'Create stage',
    description: 'Create a Databend stage (only allowed on sandbox objects by default).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Stage name' },
        url: { type: 'string', description: 'Storage URL' },
        connection_name: { ...optionalString, description: 'Optional connection name' },
      },
      required: ['name', 'url'],
      additionalProperties: false,
    },
  },
];
