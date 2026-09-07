// Agent9 API 客户端（零依赖 ESM）。
// 契约依据：agent9 仓库 docs/openapi.yaml + src/chat/dto/request-bodies.dto.ts（2026-08-20 快照）。

/**
 * 统一错误信封：{ error: { code, message } }。
 */
export class Agent9ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'Agent9ApiError';
    this.status = status;
    this.code = code;
  }
}

const DEFAULT_IDEMPOTENCY_PREFIX = 'tidbsa-';

/** 浏览器/Node 通用的随机 idempotency key。 */
export function newIdempotencyKey(prefix = DEFAULT_IDEMPOTENCY_PREFIX) {
  return `${prefix}${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

/** hex → base64（浏览器/Node 通用） */
export function hexToBase64(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  if (typeof btoa === 'function') return btoa(bin);
  return Buffer.from(bin, 'binary').toString('base64');
}

export class Agent9Client {
  /**
   * @param {{ baseUrl?: string, apiKey?: string, projectId?: string }} options
   *   baseUrl 为空时走相对路径（配合 Vite 代理）；apiKey 为 Bearer；projectId 写入 x-agent9-project-id。
   */
  constructor({ baseUrl = '', apiKey = '', projectId = '' } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.projectId = projectId;
  }

  /** 解析 /api 或 /livez 前缀，兼容 baseUrl 直接指向根或已含 /api。 */
  url(path) {
    const p = path.startsWith('/') ? path : `/${path}`;
    if (this.baseUrl.endsWith('/api')) return `${this.baseUrl}${p}`;
    return `${this.baseUrl}${p}`;
  }

  /**
   * 构造请求地址。baseUrl 为空时返回相对路径（浏览器走 Vite 代理），
   * 避免把相对路径错误地拼到不存在的 "http://local" 上。
   */
  buildUrl(path, query) {
    const qs = query
      ? `?${new URLSearchParams(
          Object.entries(query)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => [k, String(v)]),
        ).toString()}`
      : '';
    const p = this.url(path);
    if (!this.baseUrl) return `${p}${qs}`;
    return `${p}${qs}`;
  }

  async request(method, path, { query, body, headers = {} } = {}) {
    const url = this.buildUrl(path, query);
    const h = { ...headers };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    if (this.projectId) h['x-agent9-project-id'] = this.projectId;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(url.toString(), {
        method,
        headers: h,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const cause = err?.cause;
      const detail =
        cause?.code ??
        cause?.message ??
        (err instanceof Error ? err.message : String(err));
      throw new Agent9ApiError(
        0,
        'connection_error',
        `无法连接 Agent9（${detail}）。请确认服务已启动，且 AGENT9_BASE_URL 指向正确地址（如 http://localhost:5172）。`,
      );
    }
    if (!res.ok) {
      let code = `http_${res.status}`;
      let message = res.statusText;
      try {
        const data = await res.json();
        code = data?.error?.code ?? code;
        message = data?.error?.message ?? message;
      } catch {
        if (res.status === 500) {
          code = 'proxy_or_server_500';
          message =
            '服务返回 500 且无 JSON 错误体：通常是 Vite 代理指向的 Agent9 未启动，或服务端未捕获的异常。请检查 Agent9 是否在 localhost:5172 运行（curl http://localhost:5172/livez）。';
        }
      }
      throw new Agent9ApiError(res.status, code, message);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (data && typeof data === 'object') {
      Object.defineProperty(data, '_responseHeaders', {
        value: Object.fromEntries(res.headers.entries()),
        enumerable: false,
        configurable: true,
      });
    }
    return data;
  }

  // ---- 项目 ----
  listProjects() {
    return this.request('GET', '/api/console/projects');
  }

  // ---- Drive / 项目文件（console drive，User API Key 可读） ----
  listDriveProjects() {
    return this.request('GET', '/api/console/drive');
  }

  listDriveDirectory(projectId, { path = '', sort = 'modified', order = 'desc', type = 'all' } = {}) {
    return this.request('GET', `/api/console/drive/${encodeURIComponent(projectId)}`, {
      query: { path, sort, order, type },
    });
  }

  searchDriveProject(
    projectId,
    { q, mode = 'name', path = '', limit = 50, offset = 0, type = 'all' } = {},
  ) {
    return this.request('GET', `/api/console/drive/${encodeURIComponent(projectId)}/search`, {
      query: { q, mode, path, limit, offset, type },
    });
  }

  readDriveFile(projectId, relPath) {
    return this.request('GET', `/api/console/drive/${encodeURIComponent(projectId)}/file`, {
      query: { path: relPath },
    });
  }

  mintDriveDownloadUrl(projectId, relPath) {
    return this.request('POST', `/api/console/drive/${encodeURIComponent(projectId)}/file/download-url`, {
      body: { relPath },
    });
  }

  // ---- 健康检查（诊断用） ----
  livez() {
    return this.request('GET', '/livez');
  }

  readyz() {
    return this.request('GET', '/readyz');
  }

  // ---- Agent ----
  listAgents() {
    return this.request('GET', '/api/agents');
  }

  getAgent(agentId) {
    return this.request('GET', `/api/agents/${agentId}`);
  }

  /**
   * body 契约见 agent9 CreateAgentBody（name/model/config/memoryCredential/skillInstallations）。
   * Agent9 强制要求 Idempotency-Key 头；默认每次生成随机 key，传入 stableKey 可幂等重试。
   */
  createAgent(body, { idempotencyKey } = {}) {
    return this.request('POST', '/api/agents', {
      body,
      headers: { 'Idempotency-Key': idempotencyKey ?? newIdempotencyKey() },
    });
  }

  archiveAgent(agentId, { ifMatch } = {}) {
    return this.request('POST', `/api/agents/${agentId}/archive`, {
      body: {},
      headers: ifMatch ? { 'If-Match': ifMatch } : {},
    });
  }

  /** 更新 Agent 配置（model/runtime/memory 等）。Agent9 要求 If-Match 携带当前 ETag。 */
  patchAgentConfig(agentId, patch, { ifMatch } = {}) {
    return this.request('PATCH', `/api/agents/${agentId}/config`, {
      body: patch,
      headers: ifMatch ? { 'If-Match': ifMatch } : {},
    });
  }

  /** 校验并替换 Agent 的 Mem9 记忆 Key（仅 Agent 创建者，User API Key 可用）。 */
  putMem9Key(agentId, mem9Key) {
    return this.request('PUT', `/api/agents/${agentId}/memory/mem9/key`, {
      body: { mem9Key },
    });
  }

  /** 重命名 Agent（PATCH /api/agents/:id/name，需要 If-Match）。 */
  renameAgent(agentId, name, { ifMatch } = {}) {
    return this.request('PATCH', `/api/agents/${agentId}/name`, {
      body: { name },
      headers: ifMatch ? { 'If-Match': ifMatch } : {},
    });
  }

  /** 设置当前用户的默认 Agent（PUT /api/agents/default）。 */
  setDefaultAgent(agentId) {
    return this.request('PUT', '/api/agents/default', { body: { agentId } });
  }

  /** 获取/确保当前用户的默认 Agent（POST /api/agents/default/ensure）。 */
  ensureDefaultAgent() {
    return this.request('POST', '/api/agents/default/ensure', { body: {} });
  }

  // ---- Session / Turn ----
  createSession({ agentId, clientTag } = {}) {
    return this.request('POST', '/api/sessions', { body: { ...(agentId ? { agentId } : {}), ...(clientTag ? { clientTag } : {}) } });
  }

  getSession(sessionId) {
    return this.request('GET', `/api/sessions/${sessionId}`);
  }

  /** 删除会话（返回墓碑信息）。 */
  deleteSession(sessionId) {
    return this.request('DELETE', `/api/sessions/${sessionId}`);
  }

  renameSession(sessionId, name) {
    return this.request('POST', `/api/sessions/${sessionId}/name`, { body: { name } });
  }

  uploadSessionFile(sessionId, path, content) {
    return this.request('POST', `/api/sessions/${sessionId}/files`, { body: { path, content } });
  }

  /**
   * 发起一次 Turn 并流式消费 NDJSON 事件。
   * @param {string} sessionId
   * @param {{ text: string|string[], userFileIds?: string[], clarificationSourceTurnId?: string, outputSchema?: object }} input
   * @returns {AsyncGenerator<object>} TurnStreamEvent
   */
  async *createTurnStream(sessionId, input) {
    const url = this.buildUrl(`/api/sessions/${sessionId}/turns`);
    const h = { 'Content-Type': 'application/json' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    if (this.projectId) h['x-agent9-project-id'] = this.projectId;
    const res = await fetch(url.toString(), { method: 'POST', headers: h, body: JSON.stringify({ input }) });
    if (!res.ok) {
      let code = `http_${res.status}`;
      let message = res.statusText;
      try {
        const data = await res.json();
        code = data?.error?.code ?? code;
        message = data?.error?.message ?? message;
      } catch {}
      throw new Agent9ApiError(res.status, code, message);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield JSON.parse(line);
        nl = buffer.indexOf('\n');
      }
    }
    if (buffer.trim()) yield JSON.parse(buffer.trim());
  }

  listTurns(sessionId) {
    return this.request('GET', `/api/sessions/${sessionId}/turns`);
  }

  getTurn(sessionId, turnId) {
    return this.request('GET', `/api/sessions/${sessionId}/turns/${turnId}`);
  }

  // ---- Artifact ----
  listArtifacts(query = {}) {
    return this.request('GET', '/api/artifacts', { query });
  }

  listArtifactRevisions(artifactId, query = {}) {
    return this.request('GET', `/api/artifacts/${artifactId}/revisions`, { query });
  }

  /** 铸造公开下载票据（60 秒有效），返回 { url, expiresAt, byteSize, sha256? }。 */
  mintArtifactDownloadUrl(artifactId, revisionId) {
    return this.request('POST', `/api/artifacts/${artifactId}/revisions/${revisionId}/download-url`, {
      body: {},
    });
  }

  publishArtifact(body) {
    return this.request('POST', '/api/artifacts/publish', { body });
  }

  // ---- Scheduler ----
  listSchedulers(query = {}) {
    return this.request('GET', '/api/schedulers', { query });
  }

  createScheduler(body) {
    // POST /api/schedulers 同样强制 Idempotency-Key（幂等见证），默认随机，可传稳定 key 重试。
    return this.request('POST', '/api/schedulers', {
      body,
      headers: { 'Idempotency-Key': newIdempotencyKey('tidbsa-sched-') },
    });
  }

  listSchedulerFires(schedulerId, query = {}) {
    return this.request('GET', `/api/schedulers/${schedulerId}/fires`, { query });
  }

  /** 单个定时任务详情（响应头携带 ETag，更新/删除需要）。 */
  getScheduler(schedulerId) {
    return this.request('GET', `/api/schedulers/${schedulerId}`);
  }

  /** 获取定时任务当前 ETag。 */
  async schedulerEtag(schedulerId) {
    const res = await this.getScheduler(schedulerId);
    const etag = res?._responseHeaders?.etag;
    if (!etag) throw new Agent9ApiError(428, 'precondition_required', '未取到定时任务 ETag');
    return etag;
  }

  /** 更新定时任务（标题/提示词/频率/启用等）。PATCH 强制 If-Match，自动先取 ETag。 */
  async updateScheduler(schedulerId, patch) {
    const etag = await this.schedulerEtag(schedulerId);
    return this.request('PATCH', `/api/schedulers/${schedulerId}`, {
      body: patch,
      headers: { 'If-Match': etag },
    });
  }

  /** 删除定时任务。DELETE 强制 If-Match，自动先取 ETag。 */
  async deleteScheduler(schedulerId) {
    const etag = await this.schedulerEtag(schedulerId);
    return this.request('DELETE', `/api/schedulers/${schedulerId}`, {
      headers: { 'If-Match': etag },
    });
  }

  // ---- Billing（需要 workspace key + billing:read 权限） ----
  getBillingUsage(userId, from, to, interval = 'day') {
    return this.request('GET', `/api/workspace/users/${userId}/billing/usage`, {
      query: { from, to, interval },
    });
  }

  // ---- 模型目录 ----
  listAgentModels() {
    return this.request('GET', '/api/agent-models');
  }

  // ---- Lark / 飞书连接器 ----
  getLarkTools() {
    return this.request('GET', '/api/agents/lark/tools');
  }

  patchLarkCapability(coverageItemIds) {
    return this.request('PATCH', '/api/agents/lark/capability', { body: { coverageItemIds } });
  }

  getLarkAuthorizeUrl(agentId) {
    return this.request('GET', `/api/lark/agents/${agentId}/lark/authorize`);
  }

  // ---- 用户文件（附件） ----
  uploadCapabilities() {
    return this.request('GET', '/api/user-files/upload-capabilities');
  }

  createUserFileUpload(body, { idempotencyKey } = {}) {
    return this.request('POST', '/api/user-files/uploads', {
      body,
      headers: { 'Idempotency-Key': idempotencyKey ?? newIdempotencyKey('tidbsa-file-') },
    });
  }

  /** 上传整文件字节（agent9 内联模式）。 */
  async putUserFileContent(uploadId, bytes, sha256) {
    const url = this.buildUrl(`/api/user-files/uploads/${uploadId}/content`);
    const h = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.byteLength ?? bytes.length),
      'Content-Digest': `sha-256=:${hexToBase64(sha256)}:`,
    };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    if (this.projectId) h['x-agent9-project-id'] = this.projectId;
    const res = await fetch(url, { method: 'PUT', headers: h, body: bytes });
    if (!res.ok) {
      let message = res.statusText;
      try {
        const data = await res.json();
        message = data?.error?.message ?? data?.message ?? message;
      } catch {}
      throw new Agent9ApiError(res.status, `http_${res.status}`, message);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // ---- Skill 上传 / 安装 ----
  /**
   * 上传 Skill ZIP（POST /api/skills，multipart）。返回 201（已创建）或 202（待确认）。
   * @param {{ scope: 'private'|'workspace', fileName: string, bytes: Uint8Array, idempotencyKey?: string }} input
   */
  async uploadSkill({ scope, fileName, bytes, idempotencyKey } = {}) {
    const form = new FormData();
    form.append('scope', scope ?? 'private');
    form.append('package', new Blob([bytes], { type: 'application/zip' }), fileName ?? 'skill-package.zip');
    const url = this.buildUrl('/api/skills');
    const h = { 'Idempotency-Key': idempotencyKey ?? newIdempotencyKey('tidbsa-skill-') };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    if (this.projectId) h['x-agent9-project-id'] = this.projectId;
    const res = await fetch(url, { method: 'POST', headers: h, body: form });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new Agent9ApiError(
        res.status,
        data?.error?.code ?? `http_${res.status}`,
        data?.error?.message ?? res.statusText,
      );
    }
    if (data && typeof data === 'object') {
      Object.defineProperty(data, '_responseHeaders', {
        value: Object.fromEntries(res.headers.entries()),
        enumerable: false,
        configurable: true,
      });
    }
    return data;
  }

  // ---- Custom Tools（客户自定义工具，Agent9 #820） ----
  listCustomTools(agentId) {
    return this.request('GET', '/api/console/custom-tools', {
      query: agentId ? { agentId } : undefined,
    });
  }

  /** 上传自定义工具 ZIP（multipart：scope + package，包内需 manifest.json + index.mjs）。 */
  async uploadCustomTool({ scope, fileName, bytes }) {
    const form = new FormData();
    form.append('scope', scope ?? 'personal');
    form.append('package', new Blob([bytes], { type: 'application/zip' }), fileName ?? 'custom-tool.zip');
    const url = this.buildUrl('/api/console/custom-tools');
    const h = { 'Cache-Control': 'private, no-store' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    if (this.projectId) h['x-agent9-project-id'] = this.projectId;
    const res = await fetch(url, { method: 'POST', headers: h, body: form });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new Agent9ApiError(
        res.status,
        data?.error?.code ?? `http_${res.status}`,
        data?.error?.message ?? res.statusText,
      );
    }
    return data;
  }

  deleteCustomTool(toolVersionId) {
    return this.request('DELETE', `/api/console/custom-tools/${toolVersionId}`);
  }

  publishCustomTool(toolVersionId) {
    return this.request('POST', `/api/console/custom-tools/${toolVersionId}/publish`, { body: {} });
  }

  mountCustomTool(toolVersionId, agentId) {
    return this.request('POST', `/api/console/custom-tools/${toolVersionId}/mount`, {
      body: { agentId },
    });
  }

  setCustomToolPolicy(toolVersionId, policy) {
    return this.request('PUT', `/api/console/custom-tools/${toolVersionId}/policy`, {
      body: { policy },
    });
  }

  connectCustomToolCredential(toolVersionId, credentialEnv, value, expectedRevision = null) {
    return this.request('PUT', `/api/console/custom-tools/${toolVersionId}/connections/${credentialEnv}`, {
      body: { value, expectedRevision },
    });
  }

  disconnectCustomToolCredential(toolVersionId, credentialEnv, expectedRevision) {
    return this.request('DELETE', `/api/console/custom-tools/${toolVersionId}/connections/${credentialEnv}`, {
      body: { expectedRevision },
    });
  }

  // ---- 飞书 Agent 入站频道（Agent9 #819） ----
  getLarkInbound(agentId) {
    return this.request('GET', `/api/agents/${agentId}/lark/inbound`);
  }

  setLarkInbound(agentId, enabled) {
    return this.request('PUT', `/api/agents/${agentId}/lark/inbound`, { body: { enabled } });
  }

  // ---- Scheduler Webhook（Agent9 #921/#923/#927/#929） ----
  getSchedulerWebhook() {
    return this.request('GET', '/api/admin/workspace/scheduler-webhook');
  }

  createSchedulerWebhook(endpointUrl) {
    return this.request('POST', '/api/admin/workspace/scheduler-webhook', { body: { endpointUrl } });
  }

  patchSchedulerWebhook(enabled, { ifMatch } = {}) {
    return this.request('PATCH', '/api/admin/workspace/scheduler-webhook', {
      body: { enabled },
      headers: ifMatch ? { 'If-Match': ifMatch } : {},
    });
  }

  deleteSchedulerWebhook({ ifMatch } = {}) {
    return this.request('DELETE', '/api/admin/workspace/scheduler-webhook', {
      headers: ifMatch ? { 'If-Match': ifMatch } : {},
    });
  }

  // ---- MCP Server（Agent9 src/mcp，streamable_http） ----
  listMcpServers() {
    return this.request('GET', '/api/mcp/servers');
  }

  createMcpServer({ displayName, endpointUrl, scope }) {
    return this.request('POST', '/api/mcp/servers', {
      body: { displayName, endpointUrl, transport: 'streamable_http', scope },
    });
  }

  updateMcpServer(serverId, patch) {
    return this.request('PATCH', `/api/mcp/servers/${serverId}`, { body: patch });
  }

  activateMcpServer(serverId, expectedServerVersion) {
    return this.request('POST', `/api/mcp/servers/${serverId}/activate`, {
      body: { expectedServerVersion },
    });
  }

  deactivateMcpServer(serverId, expectedServerVersion) {
    return this.request('POST', `/api/mcp/servers/${serverId}/deactivate`, {
      body: { expectedServerVersion },
    });
  }

  getMcpCredential(serverId) {
    return this.request('GET', `/api/mcp/servers/${serverId}/credential`);
  }

  putMcpCredential(serverId, input) {
    return this.request('PUT', `/api/mcp/servers/${serverId}/credential`, { body: input });
  }

  rotateMcpCredential(serverId, { expectedCurrentVersion, secret }) {
    return this.request('POST', `/api/mcp/servers/${serverId}/credential/rotate`, {
      body: { expectedCurrentVersion, secret },
    });
  }

  confirmSkillIngestion(ingestionId, { ifMatch, idempotencyKey } = {}) {
    return this.request('POST', `/api/skills/ingestions/${ingestionId}`, {
      body: {},
      headers: {
        ...(ifMatch ? { 'If-Match': ifMatch } : {}),
        'Idempotency-Key': idempotencyKey ?? newIdempotencyKey('tidbsa-skill-confirm-'),
      },
    });
  }

  installSkillToAgent(agentId, { skillId, version }, { ifMatch, idempotencyKey } = {}) {
    return this.request('POST', `/api/agents/${agentId}/skill-installations`, {
      body: { skillId, version },
      headers: {
        ...(ifMatch ? { 'If-Match': ifMatch } : {}),
        'Idempotency-Key': idempotencyKey ?? newIdempotencyKey('tidbsa-skill-install-'),
      },
    });
  }

  listAgentSkills(agentId) {
    return this.request('GET', `/api/agents/${agentId}/skill-installations`);
  }

  /** 技能目录（必须显式指定 scope：private | workspace）。 */
  listSkills(scope = 'private') {
    return this.request('GET', '/api/skills', { query: { scope } });
  }

  getSkillFiles(skillId, version) {
    return this.request('GET', `/api/skills/${skillId}/files`, { query: { version } });
  }

  /** 读取技能包内单个文件（接口返回原始字节，SKILL.md 按 UTF-8 文本返回）。 */
  async getSkillFile(skillId, version, path) {
    const url = this.buildUrl(`/api/skills/${skillId}/file`, { version, path });
    const h = {};
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    if (this.projectId) h['x-agent9-project-id'] = this.projectId;
    const res = await fetch(url, { method: 'GET', headers: h });
    if (!res.ok) {
      let message = res.statusText;
      try {
        const data = await res.json();
        message = data?.error?.message ?? message;
      } catch {
        /* 非 JSON 错误体 */
      }
      throw new Agent9ApiError(res.status, `http_${res.status}`, message);
    }
    return res.text();
  }
}

export const TURN_EVENT_TYPES = [
  'turn_started',
  'operation_step',
  'assistant_draft',
  'assistant_message',
  'turn_finished',
  'turn_error',
] ;
