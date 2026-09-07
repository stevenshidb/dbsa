import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Agent9Client, newIdempotencyKey } from '../../../packages/client/src/index.js';
import { MockSession, SCENARIOS, MOCK_AGENTS, mockSessions } from './mock';
import { EXPERTS, expertCaps, newExpertScenario } from './experts';
import { MarkdownView } from './markdown';
import Connectors from './connectors';
import AgentEditor from './agent-editor';
import ArtifactCard from './artifacts';
import { CustomToolsPage, WebhookPage } from './tooling';
import CustomerDossier from './customer-dossier';
import MemoryKnowledgePanel from './memory-kb';

const LS_SETTINGS = 'tidbsa.settings.v1';
const LS_SESSIONS = 'tidbsa.sessions.v1'; // { [agentId]: [{sessionId,name,createdAt}] }
const LS_PROJECTS = 'tidbsa.projects.v1'; // { [agentId]: { folders, sessionFolder, profiles } }
const LS_SCHEDMETA = 'tidbsa.schedmeta.v1'; // { [schedulerId]: { notify, label } }
const LS_EXPERTS = 'tidbsa.experts.v1'; // 专家场景（可编辑，本地保存）
const LS_REMINDERS_READ = 'tidbsa.reminders.read.v1'; // { lastReadAt }
const LS_TRANSCRIPTS = 'tidbsa.transcripts.v2'; // { [agentId]: { [sessionId]: messages[] } }
const MAX_ATTACHMENTS = 3;
const MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5', 'DeepSeek-V4-Flash'];
const DOW = { 0: '周日', 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六' };

let msgSeq = 0;
const newMsgId = () => `m_${Date.now().toString(36)}_${(msgSeq += 1)}`;

/** 未读提醒 = 已生成新会话（result.sessionId）且触发时间晚于上次已读时间。 */
const computeUnread = (fires, lastReadAt) =>
  fires.filter(
    (f) => f.resultSessionId && (!lastReadAt || new Date(f.createdAt) > new Date(lastReadAt)),
  ).length;

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

function saveTranscript(agentId, sessionId, messages) {
  if (!agentId || !sessionId) return;
  try {
    const all = loadJson(LS_TRANSCRIPTS, {});
    const byAgent = all[agentId] ?? {};
    byAgent[sessionId] = (messages ?? []).slice(-200);
    all[agentId] = byAgent;
    localStorage.setItem(LS_TRANSCRIPTS, JSON.stringify(all));
  } catch {
    /* 本地缓存失败不影响主流程 */
  }
}

function loadTranscript(agentId, sessionId) {
  if (!agentId || !sessionId) return null;
  return loadJson(LS_TRANSCRIPTS, {})[agentId]?.[sessionId] ?? null;
}

function friendlyError(err) {
  const m = err?.message ?? String(err);
  if (m.startsWith('无法连接 Agent9')) return m;
  if (err?.code === 'connection_error' || /fetch failed|failed to fetch|networkerror/i.test(m)) {
    return `无法连接 Agent9（${m}）。请打开左下角「配置 → 设置」检查地址与密钥。`;
  }
  return m;
}

/** 把一个 PublicTurn 里可展示的“记忆/团队知识库”来源提取出来。 */
function sourcesFromTurn(turn) {
  const sources = [];
  for (const op of turn?.operations ?? []) {
    if (op.kind === 'memory.recall' && op.status === 'succeeded') {
      for (const item of op.memorySourceAudit?.items ?? []) {
        const src = item.source;
        if (!src || src.state !== 'resolved' || !src.session?.sessionId) continue;
        sources.push({
          id: `mem-${op.id}-${sources.length}`,
          type: 'memory',
          title: src.session.displayTitle ?? '历史会话记忆',
          preview: String(item.content ?? '').slice(0, 160),
          sessionId: src.session.sessionId,
          projectId: src.session.projectId,
          messageId: src.message?.messageId,
          sourcePreview: src.message?.contentPreview,
        });
        if (sources.length >= 6) break;
      }
    } else if (op.kind === 'kb.search' || op.kind === 'kb.search_collections') {
      const details = op.output?.details ?? op.output ?? {};
      const citations = Array.isArray(details.citations) ? details.citations : [];
      for (const c of citations.slice(0, 4)) {
        const title = c.documentTitle || c.collectionName || '团队知识库文档';
        sources.push({
          id: `kb-${op.id}-${sources.length}`,
          type: 'kb',
          title: String(title).slice(0, 120),
          preview: String(c.snippet ?? '').slice(0, 160),
          uri: c.sourceUri ?? null,
          resourceId: c.resourceId ?? null,
        });
      }
      if (sources.length >= 6) break;
    }
  }
  return sources.slice(0, 6);
}

async function fileSha256(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const CAPABILITIES = [
  { id: 'agent', name: 'Agent 管理', desc: '创建/配置「TiDB 售前助手」角色（模型/记忆/工具/沙箱）', api: 'POST /api/agents', mock: true },
  { id: 'session', name: 'Session / Turn', desc: '一客户一会话，NDJSON 流式对话与澄清提问', api: 'POST /api/sessions · /turns', mock: true },
  { id: 'files', name: '客户文件', desc: '对话框直接附加 RFP / 招标文件（自动校验 SHA-256）', api: 'POST /api/user-files/uploads', mock: true },
  { id: 'skill', name: '售前技能包', desc: '上传 SKILL.zip → 安装到 Agent（POC/方案/竞品速查）', api: 'POST /api/skills · install', mock: true },
  { id: 'memory', name: '客户记忆（Mem9）', desc: '客户画像、历史偏好、决策记录自动沉淀与召回', api: 'config.memory + memory.recall/write', mock: true },
  { id: 'recall', name: '会话召回', desc: '跨会话回忆「这个客户上次聊过什么」', api: 'config.sessionRecall', mock: false },
  { id: 'kb', name: '知识库', desc: '案例库 / FAQ / 白皮书 / 架构图检索与引用', api: 'POST /api/console/workspace/kb-connections', mock: true },
  { id: 'artifact', name: '方案制品', desc: '方案书 / 标书 / 报价单版本化与下载', api: 'POST /api/artifacts/publish', mock: false },
  { id: 'web', name: 'Web 搜索', desc: '竞品动态、行业资讯、市场情报', api: 'web_search 工具（EXA）', mock: true },
  { id: 'scheduler', name: '定时跟进', desc: '每周客户跟进、投标倒计时（cron/once）', api: 'POST /api/schedulers', mock: true },
  { id: 'lark', name: '飞书集成', desc: '发消息、建日程、查日历，触达售前与客户', api: 'lark_* 工具', mock: false },
  { id: 'notion', name: 'Notion 沉淀', desc: '方案与经验一键沉淀到团队知识库', api: 'notion.page.create 等', mock: false },
  { id: 'media', name: '生成媒体', desc: '方案封面、架构图配图', api: 'image_generate 工具', mock: false },
  { id: 'billing', name: '用量与成本', desc: '每售前/客户成本看板', api: 'GET /api/workspace/users/:id/billing/usage', mock: false },
  { id: 'console', name: '观测台', desc: '会话 / Operation / 审计回放', api: '/api/console/*', mock: false },
];

const ChatMessage = memo(function ChatMessage(props: any) {
  const { msg, copied, editing, draft, onCopy, onEdit, onDraft, onSave, onCancel, client, resolveUrl, live, onError, onOpenSource } = props;
  const isUser = msg.role === 'user';
  const time = msg.createdAt
    ? new Date(msg.createdAt).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
  return (
    <div className={`msg-wrap ${isUser ? 'msg-user-wrap' : 'msg-bot-wrap'} ${editing ? 'editing' : ''}`}>
      <div className={`msg ${isUser ? 'msg-user' : 'msg-bot'}`}>
        {!isUser && msg.ops?.length > 0 && (
          <div className="ops">
            {msg.ops.map((op, i) => (
              <div key={i} className="op">
                <span className="op-mark">✓</span> {op.label}
              </div>
            ))}
          </div>
        )}
        {msg.attachments?.length > 0 && (
          <div className="attach-chips">
            {msg.attachments.map((a, i) => (
              <span key={i} className="attach-chip">📎 {a}</span>
            ))}
          </div>
        )}
        {editing ? (
          <textarea
            className="edit-area"
            value={draft}
            autoFocus
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSave();
              }
              if (e.key === 'Escape') onCancel();
            }}
          />
        ) : (
          <>
            <MarkdownView text={msg.text} diagrams={msg.final !== false} />
            {msg.artifacts?.length > 0 && (
              <div className="msg-artifacts">
                {msg.artifacts.map((a) => (
                  <ArtifactCard
                    key={`${a.artifactId}-${a.revisionId}`}
                    artifact={a}
                    client={client}
                    resolveUrl={resolveUrl}
                    live={live}
                    onError={onError}
                  />
                ))}
              </div>
            )}
            {!isUser && msg.sources?.length > 0 && (
              <div className="msg-sources">
                <span className="msg-sources-label">📚 来源：</span>
                {msg.sources.map((s) => (
                  <button key={s.id ?? `${s.type}-${s.title}`} className="source-chip" onClick={() => onOpenSource?.(s)} title={s.preview ?? ''}>
                    {s.type === 'memory' ? '🧠' : '📄'} {s.title}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <div className="msg-meta">
        <span className="msg-time">🕐 {time}</span>
        <button onClick={() => onCopy(msg)}>{copied ? '✓ 已复制' : '⧉ 复制'}</button>
        {isUser && !editing && <button onClick={() => onEdit(msg)}>✎ 编辑</button>}
        {editing && (
          <>
            <button className="meta-primary" onClick={onSave}>保存</button>
            <button onClick={onCancel}>取消</button>
          </>
        )}
      </div>
    </div>
  );
});

export default function App() {
  const [settings, setSettings] = useState(() => ({ mode: 'mock', ...loadJson(LS_SETTINGS, {}) }));
  const [agents, setAgents] = useState([]);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [sessions, setSessions] = useState([]); // 当前 Agent 的会话列表（注册表）
  const [projects, setProjects] = useState({ folders: [], sessionFolder: {} }); // 当前 Agent 的项目结构
  const [selectedSession, setSelectedSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [notice, setNotice] = useState('');
  const [nav, setNav] = useState('chat'); // chat | scheduled | plugins
  const [expanded, setExpanded] = useState({});
  const [showMore, setShowMore] = useState({});
  const [configOpen, setConfigOpen] = useState(false);
  const [configTab, setConfigTab] = useState('agents');
  const [schedulers, setSchedulers] = useState([]);
  const [schedNotice, setSchedNotice] = useState('');
  const [showSchedForm, setShowSchedForm] = useState(false);
  const [schedForm, setSchedForm] = useState({
    name: '',
    freq: 'weekly',
    time: '09:00',
    dow: '1',
    dom: '1',
    runAt: '',
    notify: true,
    prompt: '',
  });
  const [editingSchedId, setEditingSchedId] = useState(null);
  const [schedDraft, setSchedDraft] = useState('');
  const [formSchedId, setFormSchedId] = useState(null); // null=新建，id=编辑
  const [confirmDelSched, setConfirmDelSched] = useState(null);
  const [agentNotice, setAgentNotice] = useState('');
  const [skillState, setSkillState] = useState(null);
  const [agentSkills, setAgentSkills] = useState([]);
  const [skillInstructions, setSkillInstructions] = useState({});
  const [defaultAgentId, setDefaultAgentId] = useState('');
  const [editingFolderId, setEditingFolderId] = useState(null);
  const [folderDraft, setFolderDraft] = useState('');
  const [editingSessionId, setEditingSessionId] = useState(null);
  const [sessionDraft, setSessionDraft] = useState('');
  const [confirmDelUnfiled, setConfirmDelUnfiled] = useState(false);
  const [hubTab, setHubTab] = useState('experts'); // 专家·连接器 页签：experts | connectors
  const [agentEditorState, setAgentEditorState] = useState(null); // { mode:'new' } | { mode:'edit', agentId }
  const [agentEditorBack, setAgentEditorBack] = useState(null);
  const [reminders, setReminders] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [visibleCount, setVisibleCount] = useState(5); // 历史消息分批渲染窗口（初始 5 条）
  const [copiedKey, setCopiedKey] = useState(null);
  const [voiceOn, setVoiceOn] = useState(false);
  const [editingMsg, setEditingMsg] = useState(null); // { msg, draft }
  const [activeBriefing, setActiveBriefing] = useState(null); // 专家首轮简报
  const [experts, setExperts] = useState(() => {
    const saved = loadJson(LS_EXPERTS, null);
    return saved && saved.length ? saved : EXPERTS;
  });
  const [editingExpert, setEditingExpert] = useState(null); // 正在编辑的场景 id
  const [expertDraft, setExpertDraft] = useState(null); // 编辑中的场景（深拷贝）
  const [editingAgentIdx, setEditingAgentIdx] = useState(null); // 正在编辑的 Agent 下标
  const [confirmDelExpert, setConfirmDelExpert] = useState(null);
  const [expertStats, setExpertStats] = useState({});
  const bottomRef = useRef(null);
  const fileRef = useRef(null);
  const threadRef = useRef(null);
  const olderBusyRef = useRef(false);
  const voiceRecRef = useRef(null);
  const voiceBaseRef = useRef('');
  const skillFileRef = useRef(null);
  const historyCache = useRef(new Map()); // sessionId -> messages[]
  const fullHistoryLoaded = useRef(new Set()); // 已从服务端拉过完整历史的 sessionId
  const selectedSidRef = useRef('');
  const sendTurnRef = useRef(null);
  const editingMsgRef = useRef(null);

  useEffect(() => {
    editingMsgRef.current = editingMsg;
  });
  useEffect(() => {
    sendTurnRef.current = sendTurn;
  });

  const client = useMemo(
    () =>
      new Agent9Client({
        baseUrl: settings.baseUrl ?? '',
        apiKey: settings.apiKey ?? '',
        projectId: settings.projectId ?? '',
      }),
    [settings.baseUrl, settings.apiKey, settings.projectId],
  );
  const live = settings.mode !== 'mock';
  const proxyTarget = import.meta.env.VITE_AGENT9_BASE_URL || 'http://localhost:5172';
  const resolveUrl = useCallback(
    (u) => {
      if (!u) return '';
      if (/^https?:/i.test(u)) return u;
      const base = (settings.baseUrl || '').replace(/\/+$/, '');
      return `${base}${u.startsWith('/') ? u : `/${u}`}`;
    },
    [settings.baseUrl],
  );

  const saveSettings = (patch) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    localStorage.setItem(LS_SETTINGS, JSON.stringify(next));
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (nav !== 'chat') stopVoiceInput();
  }, [nav]);

  useEffect(
    () => () => {
      const rec = voiceRecRef.current;
      if (rec) {
        try {
          if (typeof rec.abort === 'function') rec.abort();
          else if (typeof rec.stop === 'function') rec.stop();
        } catch {
          /* ignore */
        }
      }
    },
    [],
  );

  const persistSessions = (agentId, list) => {
    const all = loadJson(LS_SESSIONS, {});
    all[agentId] = list;
    localStorage.setItem(LS_SESSIONS, JSON.stringify(all));
  };

  const loadProjects = (agentId) => {
    const p = loadJson(LS_PROJECTS, {})[agentId] ?? {};
    return {
      folders: p.folders ?? [],
      sessionFolder: p.sessionFolder ?? {},
      unfiledName: p.unfiledName ?? '未分类',
      profiles: p.profiles ?? {},
    };
  };
  const persistProjects = (agentId, data) => {
    const all = loadJson(LS_PROJECTS, {});
    all[agentId] = data;
    localStorage.setItem(LS_PROJECTS, JSON.stringify(all));
  };

  const push = (msg) => setMessages((prev) => [...prev, msg]);

  async function refreshAgents() {
    if (!live) {
      setAgents(MOCK_AGENTS);
      if (!selectedAgentId) setSelectedAgentId(MOCK_AGENTS[0].agentId);
      return;
    }
    try {
      const res = await client.listAgents();
      const list = res?.agents ?? res ?? [];
      setAgents(list);
      if (list.length && !list.some((a) => a.agentId === selectedAgentId)) {
        selectAgent(list[0].agentId);
      }
    } catch (err) {
      setNotice(`加载 Agent 失败：${friendlyError(err)}`);
    }
  }

  function selectAgent(agentId) {
    selectedSidRef.current = '';
    setSelectedAgentId(agentId);
    setActiveBriefing(null);
    setSelectedSession(null);
    setMessages([]);
    setAttachments([]);
    setVisibleCount(5);
    setSessions(loadJson(LS_SESSIONS, {})[agentId] ?? []);
    setProjects(loadProjects(agentId));
    setNav('chat');
  }

  /** 按 turn 关联加载会话产物（已发布制品），返回 { turnId: [artifact,...] }。 */
  const loadSessionArtifacts = async (sessionId, turnIds) => {
    if (!live || !turnIds.length) return {};
    const set = new Set(turnIds);
    const out = {};
    try {
      const res = await client.listArtifacts({ limit: 100 });
      // 目录接口返回 { artifacts: [{ artifact, revision }], nextCursor }
      const items = res?.artifacts ?? [];
      for (const item of items) {
        const art = item?.artifact ?? item;
        const rev = item?.revision ?? {};
        if (rev.sourceTurnId && set.has(rev.sourceTurnId)) {
          const key = rev.sourceTurnId;
          (out[key] ??= []).push({
            artifactId: art.artifactId,
            revisionId: rev.revisionId,
            name: rev.safeName ?? art.displayName,
            kind: art.kind,
            mimeType: rev.mimeType,
            byteSize: rev.byteSize,
            sha256: rev.sha256,
          });
        }
      }
    } catch {
      /* 制品列表不可用时忽略 */
    }
    return out;
  };

  async function createSession(targetFolderId = null) {
    const agentId = selectedAgentId;
    if (!agentId && live) {
      await refreshAgents();
    }
    if (!selectedAgentId) {
      setNotice('请先在左上角选择 Agent');
      return null;
    }
    let s;
    if (!live) {
      s = new MockSession();
      const row = { sessionId: s.id, name: `Mock 会话 ${s.id.slice(-4)}`, createdAt: new Date().toISOString() };
      const list = [...sessions, row];
      setSessions(list);
      persistSessions(selectedAgentId, list);
      mockSessions(selectedAgentId).push(row);
    } else {
      try {
        const res = await client.createSession({ agentId: selectedAgentId });
        const created = res?.session ?? res;
        s = created;
        const row = { sessionId: created.sessionId, name: created.name ?? `会话 ${created.sessionId.slice(-6)}`, createdAt: created.createdAt };
        const list = [row, ...sessions];
        setSessions(list);
        persistSessions(selectedAgentId, list);
      } catch (err) {
        setNotice(`创建会话失败：${friendlyError(err)}`);
        return null;
      }
    }
    if (targetFolderId) {
      const data = { ...projects, sessionFolder: { ...projects.sessionFolder, [s.sessionId ?? s.id]: targetFolderId } };
      setProjects(data);
      persistProjects(selectedAgentId, data);
    }
    setSelectedSession(s);
    selectedSidRef.current = s.sessionId ?? s.id ?? '';
    setMessages([]);
    setAttachments([]);
    setVisibleCount(5);
    setNav('chat');
    return s;
  }

  /** 拉取一个会话的全部 Turn 并写入内存/本地缓存；不负责切换页面或设置 messages。 */
  async function fetchSessionBundle(sessionId) {
    if (fullHistoryLoaded.current.has(sessionId)) {
      const existing = historyCache.current.get(sessionId);
      if (existing) {
        return { msgs: existing, turnIds: existing.filter((m) => m.turnId).map((m) => m.turnId) };
      }
    }
    const res = await client.listTurns(sessionId);
    const turns = res?.turns ?? res ?? [];
    const msgs = [];
    for (const t of turns) {
      msgs.push({
        id: t.userMessage?.id ?? newMsgId(),
        role: 'user',
        text: t.userMessage?.content ?? '',
        createdAt: t.userMessage?.createdAt,
        final: true,
      });
      if (t.assistantMessage) {
        const turnSources = sourcesFromTurn(t);
        msgs.push({
          id: t.assistantMessage.id ?? newMsgId(),
          turnId: t.id,
          role: 'assistant',
          text: t.assistantMessage.content ?? '',
          createdAt: t.assistantMessage.createdAt,
          final: true,
          ops: (t.operations ?? [])
            .filter((o) => o.kind !== 'llm.complete' && o.status === 'succeeded')
            .slice(0, 6)
            .map((o) => ({ label: o.kind })),
          ...(turnSources.length ? { sources: turnSources } : {}),
        });
      }
    }
    historyCache.current.set(sessionId, msgs);
    fullHistoryLoaded.current.add(sessionId);
    saveTranscript(selectedAgentId, sessionId, msgs);
    return {
      msgs,
      turnIds: turns.map((t) => t.id).filter(Boolean),
    };
  }

  async function loadSession(rowOrSession) {
    const sessionId = rowOrSession.sessionId ?? rowOrSession.id;
    selectedSidRef.current = sessionId;
    setSelectedSession({ sessionId });
    setNav('chat');
    setVisibleCount(5); // 先只展示最近 5 条，向上滚动时再分批加载更早内容
    if (!live) {
      setSelectedSession(rowOrSession.sessionId ? rowOrSession : new MockSession(rowOrSession.sessionId ?? rowOrSession));
      setMessages([]);
      return;
    }
    const cached = historyCache.current.get(sessionId);
    const local = cached ? null : loadTranscript(selectedAgentId, sessionId);
    const immediate = cached ?? local;
    if (immediate) {
      // 命中本地/内存记录：立即展示最近 5 条，不出现“正在加载…”
      setMessages(immediate);
    } else {
      setMessages([{ id: newMsgId(), role: 'assistant', text: '⏳ 正在加载会话历史…', createdAt: new Date().toISOString(), final: true }]);
    }
    try {
      const { msgs, turnIds } = await fetchSessionBundle(sessionId);
      if (selectedSidRef.current !== sessionId) return;
      setMessages(msgs);
      setVisibleCount(5);

      // 产物放到后台加载：先出文本，产物到了再补卡片，不阻塞首屏。
      const artMap = await loadSessionArtifacts(sessionId, turnIds);
      if (selectedSidRef.current !== sessionId || Object.keys(artMap).length === 0) return;
      const attach = (arr) =>
        arr.map((m) => {
          if (m.role !== 'assistant' || !m.turnId || !artMap[m.turnId]?.length) return m;
          return { ...m, artifacts: artMap[m.turnId] };
        });
      const enriched = attach(msgs);
      historyCache.current.set(sessionId, enriched);
      saveTranscript(selectedAgentId, sessionId, enriched);
      setMessages((prev) => {
        const next = attach(prev);
        if (next.length !== prev.length || prev.some((m, i) => next[i] !== m)) {
          historyCache.current.set(sessionId, next);
          saveTranscript(selectedAgentId, sessionId, next);
        }
        return next;
      });
    } catch (err) {
      if (immediate) {
        setNotice(`后台刷新历史失败，已展示本地最近记录：${friendlyError(err)}`);
      } else {
        setMessages([{ id: newMsgId(), role: 'assistant', text: `⚠ 加载会话失败：${friendlyError(err)}`, createdAt: new Date().toISOString(), final: true }]);
        setNotice(`加载会话失败：${friendlyError(err)}`);
      }
    }
  }

  function openMessageSource(source) {
    if (source?.type === 'memory' && source.sessionId) {
      loadSession({ sessionId: source.sessionId });
    } else if (source?.uri) {
      window.open(source.uri, '_blank', 'noopener');
    }
  }

  async function sendTurn(text, sceneId = '', { silentUser = false, directFileIds = [] } = {}) {
    if (!text?.trim() || busy) return;
    setBusy(true);
    setNotice('');
    // 先确保会话存在（createSession 会重置消息列表，必须在插入气泡之前）
    let session = selectedSession;
    if (!session) session = await createSession();
    if (!session) {
      setBusy(false);
      return;
    }
    const sid = session.sessionId ?? session.id;
    const attNames = attachments.map((a) => a.name);
    if (!silentUser) {
      push({ id: newMsgId(), role: 'user', text, attachments: attNames, createdAt: new Date().toISOString(), final: true });
    }
    let bot = { id: newMsgId(), role: 'assistant', text: '', ops: [], createdAt: new Date().toISOString(), final: false };
    let finalText = text;
    if (activeBriefing && (!selectedSession || messages.length === 0)) {
      finalText = `${activeBriefing}\n\n${text}`;
      setActiveBriefing(null);
    }
    push(bot);
    // 不可变更新：每次只替换最后一条（bot），配合 React.memo 避免整屏重渲染
    const updateBot = (patch) => {
      bot = { ...bot, ...patch };
      setMessages((prev) => [...prev.slice(0, -1), bot]);
    };
    const userFileIds =
      directFileIds.length > 0
        ? directFileIds
        : live
          ? attachments.filter((a) => a.id).map((a) => a.id)
          : undefined;
    const turnText = live ? text : `【附件】${attNames.join('、')}\n\n${text}`;
    let turnId = '';
    try {
      const events = live
        ? client.createTurnStream(sid, { type: 'text', text: finalText, ...(userFileIds?.length ? { userFileIds } : {}) })
        : session.turns(turnText, sceneId);
      for await (const ev of events) {
        if (ev.event === 'turn_started') {
          turnId = ev.turnId ?? turnId;
        } else if (ev.event === 'operation_step') {
          updateBot({ ops: [...bot.ops, { label: ev.payload?.label ?? ev.payload?.operationId ?? '执行步骤' }] });
        } else if (ev.event === 'assistant_draft') {
          updateBot({ text: ev.payload?.text ?? bot.text });
        } else if (ev.event === 'assistant_message') {
          updateBot({ text: ev.payload?.text ?? bot.text, createdAt: ev.createdAt ?? bot.createdAt, final: true });
        } else if (ev.event === 'turn_error') {
          updateBot({ text: `⚠ 出错：${ev.payload?.message ?? '未知错误'}` });
        } else if (ev.event === 'turn_finished' && ev.payload?.status === 'failed') {
          if (!bot.text) updateBot({ text: '⚠ Turn 执行失败' });
        }
      }
      updateBot({ final: true, text: bot.text || '（未收到回复）' });
      setAttachments([]);
      let turnSources = [];
      if (!live) {
        turnSources = [
          { id: 'mock-mem-1', type: 'memory', title: '客户历史会话（Mock）', preview: '此前确认：客户优先评估 HTAP 与 MySQL 兼容性。', sessionId: '' },
          { id: 'mock-kb-1', type: 'kb', title: 'TiDB 迁移最佳实践（Mock 团队资料）', preview: '建议先做影子库全量校验再灰度切换。' },
        ];
        updateBot({
          artifacts: [
            { artifactId: 'art_mock_1', revisionId: 'rev_mock_1', name: '方案概要.md', kind: 'document', mimeType: 'text/markdown', byteSize: 2048 },
            { artifactId: 'art_mock_2', revisionId: 'rev_mock_2', name: '架构图.png', kind: 'image', mimeType: 'image/png', byteSize: 65536 },
          ],
          sources: turnSources,
        });
      } else if (turnId) {
        try {
          const turnRes = await client.getTurn(sid, turnId);
          const turn = turnRes?.turn ?? turnRes;
          turnSources = sourcesFromTurn(turn);
          if (turnSources.length) updateBot({ sources: turnSources });
        } catch {
          // 引用增强失败不影响正文
        }
        const artMap = await loadSessionArtifacts(sid, [turnId]);
        if (artMap[turnId]?.length) updateBot({ artifacts: artMap[turnId] });
      }
      setMessages((prev) => {
        const next = [...prev.slice(0, -1), bot];
        historyCache.current.set(sid, next);
        saveTranscript(selectedAgentId, sid, next);
        return next;
      });
    } catch (err) {
      updateBot({ final: true, text: `⚠ ${friendlyError(err)}` });
    } finally {
      setBusy(false);
    }
  }

  // ---- 语音输入（浏览器 Web Speech，中文连续识别） ----
  const speechSupported = () => {
    const w = window;
    return Boolean((w as any).SpeechRecognition || (w as any).webkitSpeechRecognition);
  };

  function stopVoiceInput() {
    const rec = voiceRecRef.current;
    if (!rec) return;
    try {
      if (typeof rec.stop === 'function') rec.stop();
      else if (typeof rec.abort === 'function') rec.abort();
    } catch {
      /* ignore */
    }
  }

  function toggleVoiceInput() {
    const current = voiceRecRef.current;
    if (current) {
      stopVoiceInput();
      return;
    }
    const w = window;
    const SR = (w as any).SpeechRecognition || (w as any).webkitSpeechRecognition;
    if (!SR) {
      setNotice('当前浏览器不支持语音输入，请使用 Chrome / Edge，或检查是否通过 https:// 或 localhost 访问。');
      return;
    }
    const rec = new SR();
    rec.lang = 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (event) => {
      const results = event.results ?? [];
      let text = '';
      for (let i = 0; i < results.length; i += 1) {
        text += results[i]?.[0]?.transcript ?? '';
      }
      setInput(`${voiceBaseRef.current}${text}`.trim());
    };
    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setNotice('麦克风权限被拒绝：请在浏览器地址栏允许麦克风后重试。');
      } else if (event.error !== 'aborted' && event.error !== 'no-speech') {
        setNotice(`语音识别错误：${event.error}`);
      }
    };
    rec.onend = () => {
      if (voiceRecRef.current === rec) voiceRecRef.current = null;
      setVoiceOn(false);
    };
    try {
      voiceBaseRef.current = input.trim() ? `${input.trim()} ` : '';
      rec.start();
      voiceRecRef.current = rec;
      setVoiceOn(true);
      setNotice('');
    } catch (error) {
      setNotice(`启动语音识别失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function submitChat(text = input) {
    stopVoiceInput();
    sendTurn(text);
    setInput('');
  }

  async function uploadUserFile(file) {
    const sha256 = await fileSha256(file);
    if (!live) return { id: null, name: file.name };
    const caps = await client.uploadCapabilities();
    const maxBytes = caps?.capabilities?.maxUploadBytes ?? 50 * 1024 * 1024;
    if (file.size > maxBytes) throw new Error(`文件超过上限 ${Math.round(maxBytes / 1024 / 1024)} MiB`);
    const created = await client.createUserFileUpload(
      { originalName: file.name, byteSize: file.size, sha256, contentType: file.type || null },
      { idempotencyKey: newIdempotencyKey('tidbsa-file-') },
    );
    const upload = created?.upload ?? created;
    if (upload.mode !== 'agent9') throw new Error(`当前后端为 ${upload.mode} 上传模式，Demo 支持 agent9 内联模式`);
    await client.putUserFileContent(upload.uploadId, await file.arrayBuffer(), sha256);
    return { id: upload.uploadId, name: file.name };
  }

  async function handleFiles(files) {
    const picked = [...files].slice(0, MAX_ATTACHMENTS - attachments.length);
    if (!picked.length) return;
    const next = [...attachments];
    for (const file of picked) {
      next.push({ name: file.name, status: '读取中' });
      setAttachments([...next]);
      try {
        const uploaded = await uploadUserFile(file);
        const done = next.find((a) => a.name === file.name);
        done.id = uploaded.id;
        done.status = live ? '就绪' : '就绪(Mock)';
        setAttachments([...next]);
      } catch (err) {
        const fail = next.find((a) => a.name === file.name);
        fail.status = `失败：${friendlyError(err)}`;
        setAttachments([...next]);
      }
    }
  }

  function removeAttachment(name) {
    setAttachments((prev) => prev.filter((a) => a.name !== name));
  }

  async function analyzeDriveFile(folderId, file) {
    setNotice(`正在把「${file.name}」交给 Agent 分析…`);
    try {
      if (!live) {
        const session = await createSession(folderId);
        if (session) await sendTurn(`请分析客户资料「${file.name}」（Mock 资料库）。输出要点、影响和建议下一步。`);
        return;
      }
      if (!client.projectId) {
        const projects = await client.listProjects();
        client.projectId = (projects?.projects ?? projects ?? [])[0]?.projectId;
      }
      if (!client.projectId) throw new Error('未解析到 Agent9 项目');
      const dl = await client.mintDriveDownloadUrl(client.projectId, file.relPath);
      if (!dl?.url) throw new Error('未拿到文件下载票据');
      const response = await fetch(resolveUrl(dl.url));
      if (!response.ok) throw new Error(`读取文件失败（HTTP ${response.status}）`);
      const bytes = await response.arrayBuffer();
      const ext = (file.name.split('.').pop() ?? '').toLowerCase();
      const mime = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }[ext] || 'application/octet-stream';
      const uploaded = await uploadUserFile(new File([bytes], file.name, { type: mime }));
      const session = await createSession(folderId);
      if (!session) throw new Error('创建客户会话失败');
      await sendTurn(
        `请先阅读客户资料「${file.name}」，然后输出：\n1) 这份资料的关键信息摘要；\n2) 对 TiDB 售前推进的影响/机会点；\n3) 建议的下一步动作或需要澄清的问题。`,
        '',
        { directFileIds: uploaded.id ? [uploaded.id] : [] },
      );
      setNotice(`已用 Agent 分析「${file.name}」，结果见右侧对话。`);
    } catch (err) {
      setNotice(`用 Agent 分析失败：${friendlyError(err)}`);
    }
  }

  // ---- 消息悬停操作：复制 / 编辑 ----
  const copyMessage = useCallback(async (msg) => {
    const key = `${msg.role}-${msg.id ?? msg.createdAt ?? Date.now()}`;
    try {
      await navigator.clipboard.writeText(msg.text ?? '');
    } catch {
      /* 剪贴板不可用时静默 */
    }
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  }, []);

  const startEdit = useCallback((msg) => {
    setEditingMsg({ msg, draft: msg.text ?? '' });
  }, []);

  const cancelEdit = useCallback(() => setEditingMsg(null), []);

  const onDraftChange = useCallback((v) => {
    setEditingMsg((prev) => (prev ? { ...prev, draft: v } : prev));
  }, []);

  const saveEdit = useCallback(() => {
    const em = editingMsgRef.current;
    if (!em) return;
    const text = em.draft.trim();
    if (!text) {
      setEditingMsg(null);
      return;
    }
    setMessages((prev) => prev.map((m) => (m === em.msg ? { ...m, text } : m)));
    historyCache.current.clear(); // 编辑后本地缓存失效，下次从服务端重读
    setEditingMsg(null);
    void sendTurnRef.current?.(text, '', { silentUser: true });
  }, []);

  // ---- 项目/文件夹（原地编辑） ----
  function createFolder() {
    const folder = { id: `folder_${Math.random().toString(36).slice(2, 8)}`, name: '新客户' };
    const data = {
      ...projects,
      folders: [...projects.folders, folder],
      profiles: {
        ...(projects.profiles ?? {}),
        [folder.id]: { company: '', industry: '', stage: '初步接触', status: '跟进中', owner: '', notes: '' },
      },
    };
    setProjects(data);
    persistProjects(selectedAgentId, data);
    setEditingFolderId(folder.id);
    setFolderDraft('新客户');
  }

  function saveCustomerProfile(folderId, patch) {
    const profiles = {
      ...(projects.profiles ?? {}),
      [folderId]: { ...(projects.profiles?.[folderId] ?? {}), ...patch },
    };
    const data = { ...projects, profiles };
    setProjects(data);
    persistProjects(selectedAgentId, data);
  }

  function renameFolderDirect(folderId, name) {
    const clean = String(name ?? '').trim();
    if (!clean) return;
    const data = {
      ...projects,
      folders: projects.folders.map((f) => (f.id === folderId ? { ...f, name: clean } : f)),
    };
    setProjects(data);
    persistProjects(selectedAgentId, data);
  }

  function startFolderEdit(folder) {
    setEditingFolderId(folder.id);
    setFolderDraft(folder.name);
  }

  function saveFolderEdit(folderId) {
    const name = folderDraft.trim() || '新文件夹';
    const data =
      folderId === 'unfiled'
        ? { ...projects, unfiledName: name }
        : { ...projects, folders: projects.folders.map((f) => (f.id === folderId ? { ...f, name } : f)) };
    setProjects(data);
    persistProjects(selectedAgentId, data);
    setEditingFolderId(null);
    setFolderDraft('');
  }

  function startUnfiledRename() {
    setEditingFolderId('unfiled');
    setFolderDraft(projects.unfiledName ?? '未分类');
  }

  function deleteFolder(folder) {
    if (!window.confirm(`删除文件夹「${folder.name}」？其中会话将回到未分类。`)) return;
    const sessionFolder = { ...projects.sessionFolder };
    for (const [sid, fid] of Object.entries(sessionFolder)) {
      if (fid === folder.id) delete sessionFolder[sid];
    }
    const data = { folders: projects.folders.filter((f) => f.id !== folder.id), sessionFolder };
    setProjects(data);
    persistProjects(selectedAgentId, data);
    if (nav === `folder:${folder.id}`) setNav('unfiled');
  }

  function moveSession(sessionId, folderId) {
    const data = { ...projects, sessionFolder: { ...projects.sessionFolder, [sessionId]: folderId } };
    setProjects(data);
    persistProjects(selectedAgentId, data);
  }

  async function deleteUnfiledSessions() {
    const items = unfiledSessions;
    setConfirmDelUnfiled(false);
    if (!items.length) return;
    const ids = items.map((s) => s.sessionId);
    try {
      if (live) {
        for (const id of ids) await client.deleteSession(id);
      }
      const remain = sessions.filter((s) => !ids.includes(s.sessionId));
      setSessions(remain);
      if (selectedAgentId) persistSessions(selectedAgentId, remain);
      const sessionFolder = { ...projects.sessionFolder };
      for (const id of ids) delete sessionFolder[id];
      const data = { ...projects, sessionFolder };
      setProjects(data);
      if (selectedAgentId) persistProjects(selectedAgentId, data);
      if (selectedSession && ids.includes(selectedSession.sessionId)) {
        setSelectedSession(null);
        setMessages([]);
      }
      setNotice(`已删除 ${ids.length} 个未分类会话${live ? '' : '（Mock）'}`);
    } catch (err) {
      setNotice(`删除未分类会话失败：${friendlyError(err)}`);
    }
  }

  function toggleFolder(folderId) {
    setExpanded((prev) => ({ ...prev, [folderId]: prev[folderId] === undefined ? false : !prev[folderId] }));
  }

  const folderSessions = (folderId) => sessions.filter((s) => projects.sessionFolder[s.sessionId] === folderId);
  const unfiledSessions = sessions.filter((s) => !projects.sessionFolder[s.sessionId]);
  const SESSION_PREVIEW_LIMIT = 3;

  const renderSessionPreview = (key, items) => {
    const isExpanded = !!showMore[key];
    const visible = isExpanded ? items : items.slice(0, SESSION_PREVIEW_LIMIT);
    return (
      <>
        {visible.map(renderSessionRow)}
        {items.length > SESSION_PREVIEW_LIMIT && (
          <button
            className="more-sessions"
            onClick={() => setShowMore((prev) => ({ ...prev, [key]: !isExpanded }))}
          >
            {isExpanded ? '收起，只显示 3 个' : `展开全部 ${items.length} 个会话`}
          </button>
        )}
      </>
    );
  };

  // ---- 定时调度 ----
  const saveSchedMeta = (id, meta) => {
    const all = loadJson(LS_SCHEDMETA, {});
    all[id] = meta;
    localStorage.setItem(LS_SCHEDMETA, JSON.stringify(all));
  };

  async function loadSchedulers() {
    if (!live) {
      setSchedulers([]);
      setSchedNotice('Mock 模式无定时任务数据');
      return;
    }
    try {
      const res = await client.listSchedulers({ limit: 50 });
      const metaAll = loadJson(LS_SCHEDMETA, {});
      const rows = (res?.schedulers ?? res ?? []).map((s) => ({
        ...s,
        _notify: !!metaAll[s.schedulerId]?.notify,
        _label: metaAll[s.schedulerId]?.label,
      }));
      setSchedulers(rows);
      setSchedNotice('');
    } catch (err) {
      setSchedNotice(`加载定时任务失败：${friendlyError(err)}`);
    }
  }

  const buildSchedule = (form) => {
    const pad = (n) => String(n).padStart(2, '0');
    if (form.freq === 'once') {
      const d = new Date(form.runAt);
      if (Number.isNaN(d.getTime())) throw new Error('请选择一次性任务的执行时间');
      return { kind: 'once', runAt: d.toISOString() };
    }
    const [hh, mm] = form.time.split(':');
    if (form.freq === 'daily') return { kind: 'cron', cronExpr: `${mm} ${hh} * * *`, timezone: 'Asia/Shanghai' };
    if (form.freq === 'weekly') return { kind: 'cron', cronExpr: `${mm} ${hh} * * ${form.dow}`, timezone: 'Asia/Shanghai' };
    return { kind: 'cron', cronExpr: `${mm} ${hh} ${form.dom} * *`, timezone: 'Asia/Shanghai' };
  };

  const schedLabel = (form) => {
    if (form.freq === 'once') return '一次性';
    if (form.freq === 'daily') return `每天 ${form.time}`;
    if (form.freq === 'weekly') return `每周${DOW[form.dow] ?? ''} ${form.time}`;
    return `每月 ${form.dom} 号 ${form.time}`;
  };

  const isoToLocal = (iso) => {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const parseSchedToForm = (s) => {
    const base = { name: s.title ?? '', prompt: s.prompt ?? '', notify: !!s._notify };
    const sc = s.schedule ?? {};
    if (sc.kind === 'once') {
      return { ...base, freq: 'once', runAt: sc.runAt ? isoToLocal(sc.runAt) : '', time: '09:00', dow: '1', dom: '1' };
    }
    const parts = (sc.cronExpr ?? '').split(/\s+/);
    const mm = (parts[0] ?? '0').padStart(2, '0');
    const hh = (parts[1] ?? '9').padStart(2, '0');
    const dom = parts[2] ?? '*';
    const dow = parts[4] ?? '*';
    const time = `${hh}:${mm}`;
    if (dom === '*' && dow === '*') return { ...base, freq: 'daily', time, dow: '1', dom: '1', runAt: '' };
    if (dom === '*' && dow !== '*') return { ...base, freq: 'weekly', time, dow: String(dow), dom: '1', runAt: '' };
    return { ...base, freq: 'monthly', time, dom: String(dom), dow: '1', runAt: '' };
  };

  function startCreateScheduler() {
    setFormSchedId(null);
    setSchedForm({ name: '', freq: 'weekly', time: '09:00', dow: '1', dom: '1', runAt: '', notify: true, prompt: '' });
    setShowSchedForm((v) => !v);
    setSchedNotice('');
  }

  function startEditScheduler(s) {
    setFormSchedId(s.schedulerId);
    setSchedForm(parseSchedToForm(s));
    setShowSchedForm(true);
    setSchedNotice('');
  }

  async function submitSchedulerForm() {
    if (!schedForm.name.trim() || !schedForm.prompt.trim()) {
      setSchedNotice('请填写定时任务名与执行内容');
      return;
    }
    const agentId = selectedAgentId || agents[0]?.agentId;
    if (!agentId) {
      setSchedNotice('请先选择 Agent');
      return;
    }
    let schedule;
    try {
      schedule = buildSchedule(schedForm);
    } catch (err) {
      setSchedNotice(err.message);
      return;
    }
    const meta = { notify: schedForm.notify, label: schedLabel(schedForm) };
    const title = schedForm.name.trim();
    const prompt = schedForm.prompt.trim();
    if (!live) {
      if (formSchedId) {
        setSchedulers((prev) =>
          prev.map((r) => (r.schedulerId === formSchedId ? { ...r, title, prompt, schedule, _notify: meta.notify, _label: meta.label } : r)),
        );
        saveSchedMeta(formSchedId, meta);
        setSchedNotice('已保存修改（Mock）');
      } else {
        const row = {
          schedulerId: `sched_mock_${Math.random().toString(36).slice(2, 8)}`,
          title,
          prompt,
          schedule,
          status: 'enabled',
          agentId,
          _notify: meta.notify,
          _label: meta.label,
        };
        setSchedulers((prev) => [row, ...prev]);
        saveSchedMeta(row.schedulerId, meta);
        setSchedNotice('定时任务已创建（Mock）');
      }
      setShowSchedForm(false);
      setFormSchedId(null);
      setSchedForm({ name: '', freq: 'weekly', time: '09:00', dow: '1', dom: '1', runAt: '', notify: true, prompt: '' });
      return;
    }
    try {
      if (formSchedId) {
        await client.updateScheduler(formSchedId, { title, prompt, schedule });
        saveSchedMeta(formSchedId, meta);
        setSchedNotice('已保存修改');
      } else {
        const res = await client.createScheduler({
          title,
          prompt,
          agentId,
          schedule,
          delivery: { target: 'new_session' },
        });
        const sch = res?.scheduler ?? res;
        saveSchedMeta(sch.schedulerId, meta);
        setSchedNotice(`定时任务已创建：${sch.schedulerId}`);
      }
      setShowSchedForm(false);
      setFormSchedId(null);
      setSchedForm({ name: '', freq: 'weekly', time: '09:00', dow: '1', dom: '1', runAt: '', notify: true, prompt: '' });
      await loadSchedulers();
    } catch (err) {
      setSchedNotice(`${formSchedId ? '保存失败' : '创建失败'}：${friendlyError(err)}`);
    }
  }

  function startSchedRename(s) {
    setEditingSchedId(s.schedulerId);
    setSchedDraft(s.title ?? s.schedulerId);
  }

  async function saveSchedRename(id) {
    const name = schedDraft.trim();
    if (!name) {
      setEditingSchedId(null);
      setSchedDraft('');
      return;
    }
    try {
      if (live) await client.updateScheduler(id, { title: name });
      setSchedulers((prev) => prev.map((s) => (s.schedulerId === id ? { ...s, title: name } : s)));
      setSchedNotice('');
    } catch (err) {
      setSchedNotice(`改名失败：${friendlyError(err)}`);
    }
    setEditingSchedId(null);
    setSchedDraft('');
  }

  function toggleSchedNotify(id) {
    const metaAll = loadJson(LS_SCHEDMETA, {});
    const next = !(metaAll[id]?.notify ?? false);
    metaAll[id] = { ...(metaAll[id] ?? {}), notify: next };
    localStorage.setItem(LS_SCHEDMETA, JSON.stringify(metaAll));
    setSchedulers((prev) => prev.map((s) => (s.schedulerId === id ? { ...s, _notify: next } : s)));
  }

  async function confirmDeleteScheduler(sch) {
    if (!live) {
      setSchedulers((prev) => prev.filter((s) => s.schedulerId !== sch.schedulerId));
      const metaAll = loadJson(LS_SCHEDMETA, {});
      delete metaAll[sch.schedulerId];
      localStorage.setItem(LS_SCHEDMETA, JSON.stringify(metaAll));
      setSchedNotice('已删除（Mock）');
      setConfirmDelSched(null);
      return;
    }
    try {
      await client.deleteScheduler(sch.schedulerId);
      const metaAll = loadJson(LS_SCHEDMETA, {});
      delete metaAll[sch.schedulerId];
      localStorage.setItem(LS_SCHEDMETA, JSON.stringify(metaAll));
      setSchedNotice('已删除');
      setConfirmDelSched(null);
      await loadSchedulers();
    } catch (err) {
      setSchedNotice(`删除失败：${friendlyError(err)}`);
      setConfirmDelSched(null);
    }
  }

  // ---- 提醒（定时任务触发 → 新会话） ----
  const loadReminders = async () => {
    const lastRead = loadJson(LS_REMINDERS_READ, {})?.lastReadAt ?? null;
    if (!live) {
      const now = new Date();
      const mockFires = [
        {
          fireId: 'fire_mock_1',
          schedulerId: 'sched_mock_1',
          title: '示例客户每周跟进',
          scheduledFor: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
              executionStatus: 'completed',
              resultSessionId: 'sess_mock_notify_1',
              webhookStatus: 'delivered',
              createdAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
        },
        {
          fireId: 'fire_mock_2',
          schedulerId: 'sched_mock_2',
          title: '投标倒计时提醒',
          scheduledFor: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
              executionStatus: 'completed',
              resultSessionId: 'sess_mock_notify_2',
              webhookStatus: 'failed',
              createdAt: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
        },
      ];
      setReminders(mockFires);
      setUnreadCount(computeUnread(mockFires, lastRead));
      return;
    }
    try {
      const res = await client.listSchedulers({ limit: 50 });
      const scheds = res?.schedulers ?? res ?? [];
      const fires = [];
      for (const s of scheds) {
        try {
          const fr = await client.listSchedulerFires(s.schedulerId, { limit: 20 });
          for (const f of fr?.fires ?? fr ?? []) {
            fires.push({
              fireId: f.fireId,
              schedulerId: s.schedulerId,
              title: s.title ?? s.schedulerId,
              scheduledFor: f.scheduledFor,
              executionStatus: f.executionStatus,
              resultSessionId: f.result?.sessionId ?? null,
              webhookStatus: f.webhookStatus ?? null,
              createdAt: f.createdAt,
            });
          }
        } catch {
          /* 单个调度器读取失败不影响整体 */
        }
      }
      fires.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setReminders(fires);
      setUnreadCount(computeUnread(fires, lastRead));
    } catch {
      /* 网络失败保持原状态 */
    }
  };

  const markRemindersRead = () => {
    localStorage.setItem(LS_REMINDERS_READ, JSON.stringify({ lastReadAt: new Date().toISOString() }));
    setUnreadCount(0);
  };

  // ---- Agent 管理 ----
  async function createAgent() {
    setAgentNotice('');
    try {
      const res = await client.createAgent(
        {
          name: 'TiDB 售前助手',
          model: 'DeepSeek-V4-Flash',
          config: {
            runtime: { backend: 'pi' },
            memory: { enabled: true, provider: 'mem9', mem9: {} },
            sessionRecall: { enabled: true },
            knowledgeBase: { enabled: true },
            generatedMedia: { enabled: true },
            notion: { enabled: true },
            tools: { managed: [] },
          },
        },
        { idempotencyKey: newIdempotencyKey('tidbsa-agent-') },
      );
      const agent = res?.agent ?? res;
      setAgentNotice(`Agent 已创建：${agent.agentId ?? ''}`);
      await refreshAgents();
    } catch (err) {
      setAgentNotice(`创建失败：${friendlyError(err)}`);
    }
  }

  const openAgentEditor = (mode, agentId = undefined) => {
    setAgentEditorBack({ nav, hubTab, configOpen });
    setConfigOpen(false);
    setAgentEditorState(agentId ? { mode, agentId } : { mode });
  };

  const closeAgentEditor = () => {
    setAgentEditorState(null);
    if (agentEditorBack) {
      setNav(agentEditorBack.nav);
      setHubTab(agentEditorBack.hubTab);
      setConfigOpen(agentEditorBack.configOpen);
      setAgentEditorBack(null);
    }
  };

  const onAgentSaved = async (newAgentId, name) => {
    await refreshAgents();
    setNotice(`Agent 已保存：${name}`);
    closeAgentEditor();
  };

  async function agentEtag(agentId) {
    const res = await client.getAgent(agentId);
    const etag = res?._responseHeaders?.etag;
    if (!etag) throw new Error('未取到 Agent ETag');
    return etag;
  }

  async function renameAgentRow(agent) {
    const name = window.prompt('新的 Agent 名称', agent.name ?? agent.agentId);
    if (!name?.trim()) return;
    setAgentNotice('');
    try {
      const etag = await agentEtag(agent.agentId);
      await client.renameAgent(agent.agentId, name.trim(), { ifMatch: etag });
      setAgentNotice(`已重命名为「${name.trim()}」`);
      await refreshAgents();
    } catch (err) {
      setAgentNotice(`重命名失败：${friendlyError(err)}`);
    }
  }

  async function archiveAgentRow(agent) {
    if (!window.confirm(`确定归档 Agent「${agent.name ?? agent.agentId}」？归档后不可再用于新会话。`)) return;
    setAgentNotice('');
    try {
      const etag = await agentEtag(agent.agentId);
      try {
        await client.archiveAgent(agent.agentId, { ifMatch: etag });
      } catch (err) {
        const isDefaultConflict =
          err?.code === 'configuration_unavailable' || /default agent/i.test(err?.message ?? '');
        if (!isDefaultConflict) throw err;
        const others = agents.filter((a) => a.agentId !== agent.agentId && a.status === 'active');
        if (!others.length) throw new Error('没有其他可用 Agent，无法切换默认后归档');
        const target = others[0];
        if (
          !window.confirm(
            `「${agent.name ?? agent.agentId}」是当前默认 Agent。将默认切换为「${target.name ?? target.agentId}」后归档，是否继续？`,
          )
        ) {
          return;
        }
        await client.setDefaultAgent(target.agentId);
        setDefaultAgentId(target.agentId);
        const freshEtag = await agentEtag(agent.agentId);
        await client.archiveAgent(agent.agentId, { ifMatch: freshEtag });
      }
      setAgentNotice(`已归档：${agent.name ?? agent.agentId}`);
      if (selectedAgentId === agent.agentId) selectAgent('');
      await refreshAgents();
    } catch (err) {
      setAgentNotice(`归档失败：${friendlyError(err)}`);
    }
  }

  async function setDefaultAgentRow(agent) {
    setAgentNotice('');
    try {
      if (!live) {
        setDefaultAgentId(agent.agentId);
        setAgentNotice(`已将「${agent.name}」设为默认 Agent（Mock）`);
        return;
      }
      await client.setDefaultAgent(agent.agentId);
      setDefaultAgentId(agent.agentId);
      setAgentNotice(`已将「${agent.name ?? agent.agentId}」设为默认 Agent`);
    } catch (err) {
      setAgentNotice(`设置默认失败：${friendlyError(err)}`);
    }
  }

  async function loadDefaultAgent() {
    if (!live) {
      setDefaultAgentId(MOCK_AGENTS[0]?.agentId ?? '');
      return;
    }
    try {
      const res = await client.ensureDefaultAgent();
      const agent = res?.agent ?? res;
      if (agent?.agentId) setDefaultAgentId(agent.agentId);
    } catch {
      /* ignore */
    }
  }

  async function useExpertAgent(agentDef) {
    if (!live) {
      const exists = agents.some((a) => a.agentId === agentDef.id);
      if (!exists) {
        setAgents((prev) => [
          ...prev,
          { agentId: agentDef.id, name: agentDef.name, model: agentDef.model, status: 'active', configVersion: 1 },
        ]);
      }
      selectAgent(agentDef.id);
      setActiveBriefing(agentDef.briefing);
      setNav('chat');
      return;
    }
    try {
      let found = agents.find((a) => a.name === agentDef.name && a.status === 'active');
      if (!found) {
        const res = await client.createAgent(
          { name: agentDef.name, model: agentDef.model, config: agentDef.config },
          { idempotencyKey: newIdempotencyKey(`tidbsa-expert-${agentDef.id}-`) },
        );
        found = res?.agent ?? res;
        await refreshAgents();
      }
      selectAgent(found.agentId);
      setActiveBriefing(agentDef.briefing);
      setNav('chat');
    } catch (err) {
      setNotice(`切换到专家失败：${friendlyError(err)}`);
    }
  }

  const persistExperts = (list) => localStorage.setItem(LS_EXPERTS, JSON.stringify(list));

  function startExpertScenarioEdit(exp) {
    setEditingExpert(exp.id);
    setExpertDraft(JSON.parse(JSON.stringify(exp)));
    setEditingAgentIdx(null);
  }

  function startExpertAgentEdit(exp, idx) {
    setEditingExpert(exp.id);
    setExpertDraft(JSON.parse(JSON.stringify(exp)));
    setEditingAgentIdx(idx);
  }

  function saveExpertEdit() {
    if (!expertDraft?.name?.trim()) {
      setNotice('场景名称不能为空');
      return;
    }
    const next = experts.map((e) => (e.id === expertDraft.id ? expertDraft : e));
    setExperts(next);
    persistExperts(next);
    setEditingExpert(null);
    setExpertDraft(null);
    setEditingAgentIdx(null);
    setNotice(`已保存专家场景「${expertDraft.name}」`);
  }

  const cancelExpertEdit = () => {
    setEditingExpert(null);
    setExpertDraft(null);
    setEditingAgentIdx(null);
  };

  /** 加载某场景 Agent 在 Agent9 上挂载的真实资产（技能/工具/定时/飞书入站）。 */
  const loadExpertStats = async (agentDefId, realAgentId) => {
    if (!live) {
      setExpertStats((p) => ({
        ...p,
        [agentDefId]: { status: 'ready', skills: 1, tools: 1, schedulers: 1, inbound: true, mcp: 1 },
      }));
      return;
    }
    if (!realAgentId) {
      setExpertStats((p) => ({ ...p, [agentDefId]: { status: 'missing', skills: 0, tools: 0, schedulers: 0, inbound: false, mcp: 0 } }));
      return;
    }
    setExpertStats((p) => ({ ...p, [agentDefId]: { status: 'loading', skills: 0, tools: 0, schedulers: 0, inbound: false, mcp: 0 } }));
    const [sk, tl, sch, ib, mcpRes] = await Promise.allSettled([
      client.listAgentSkills(realAgentId),
      client.listCustomTools(realAgentId),
      client.listSchedulers({ limit: 50 }),
      client.getLarkInbound(realAgentId),
      client.listMcpServers(),
    ]);
    const skills = sk.status === 'fulfilled' ? (sk.value?.skillInstallations ?? sk.value ?? []).length : 0;
    const tools = tl.status === 'fulfilled' ? (tl.value?.tools ?? tl.value ?? []).length : 0;
    const schedulers = sch.status === 'fulfilled'
      ? (sch.value?.schedulers ?? sch.value ?? []).filter((s) => s.agentId === realAgentId).length
      : 0;
    const inbound = ib.status === 'fulfilled' && !!ib.value?.enabled;
    const mcp = mcpRes.status === 'fulfilled'
      ? (mcpRes.value?.servers ?? mcpRes.value ?? []).filter(
          (s) => s.scope?.kind === 'agent' && s.scope?.id === realAgentId && s.status === 'active',
        ).length
      : 0;
    setExpertStats((p) => ({ ...p, [agentDefId]: { status: 'ready', skills, tools, schedulers, inbound, mcp } }));
  };

  function addExpertScenario() {
    const id = `expert_${Math.random().toString(36).slice(2, 8)}`;
    const scenario = newExpertScenario(id);
    const next = [...experts, scenario];
    setExperts(next);
    persistExperts(next);
    // 直接进入新场景详情并进入编辑态，方便立即修改
    setNav(`expert:${id}`);
    setEditingExpert(id);
    setExpertDraft(JSON.parse(JSON.stringify(scenario)));
    setEditingAgentIdx(null);
    setNotice('已新增场景，请填写名称、描述与专家信息后保存');
  }

  async function deleteExpertScenario(exp) {
    const next = experts.filter((e) => e.id !== exp.id);
    setExperts(next);
    persistExperts(next);
    setConfirmDelExpert(null);
    setEditingExpert(null);
    setExpertDraft(null);
    setNav('experts');
    setNotice(`已删除场景「${exp.name}」`);
  }

  const renderExpertsPanel = (
    <>
      <div className="actions">
        <button onClick={addExpertScenario}>＋ 新增场景</button>
      </div>
      {notice && <div className="notice">{notice}</div>}
      <div className="grid">
        {experts.map((e) => (
          <div key={e.id} className="card expert-card" onClick={() => setNav(`expert:${e.id}`)}>
            <div className="card-title">
              <strong>{e.icon} {e.name}</strong>
              <span className="tag tag-live">{e.agents.length} 个专家</span>
            </div>
            <p>{e.description || '（未填写描述）'}</p>
            <div className="agent-id">
              {e.agents.map((a) => a.name).join('、') || '暂无 Agent'}
            </div>
            <div className="actions">
              <button onClick={(ev) => { ev.stopPropagation(); setNav(`expert:${e.id}`); }}>查看 / 编辑</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );

  const renderHub = (
    <main className="page">
      <div className="page-head">
        <h2>🔌 专家·连接器</h2>
        <p>专家场景与外部连接器（如飞书）统一在此管理。</p>
        <div className="hub-tabs">
          <button className={hubTab === 'experts' ? 'on' : ''} onClick={() => setHubTab('experts')}>👥 专家场景</button>
          <button className={hubTab === 'connectors' ? 'on' : ''} onClick={() => setHubTab('connectors')}>🔗 连接器</button>
        </div>
      </div>
      {hubTab === 'experts' ? (
        renderExpertsPanel
      ) : (
        <Connectors
          client={client}
          live={live}
          agents={agents}
          selectedAgentId={selectedAgentId}
          onNotice={setNotice}
        />
      )}
    </main>
  );

  const renderExpert = (id) => {
    const exp = experts.find((e) => e.id === id);
    if (!exp) return null;
    const draft = expertDraft?.id === exp.id ? expertDraft : exp;
    return (
      <main className="page">
        <div className="page-head">
          {editingExpert === exp.id ? (
            <div className="expert-edit-head">
              <label>场景名称
                <input value={draft.name} onChange={(e) => setExpertDraft({ ...draft, name: e.target.value })} />
              </label>
              <label>场景描述
                <textarea rows={2} value={draft.description} onChange={(e) => setExpertDraft({ ...draft, description: e.target.value })} />
              </label>
              <div className="actions">
                <button className="primary" onClick={saveExpertEdit}>保存</button>
                <button onClick={cancelExpertEdit}>取消</button>
              </div>
            </div>
          ) : (
            <>
              <h2>{exp.icon} {exp.name}</h2>
              <p>{exp.description}</p>
              <div className="actions">
                <button onClick={() => { setNav('hub'); setHubTab('experts'); }}>← 返回专家·连接器</button>
                <button onClick={() => startExpertScenarioEdit(exp)}>✎ 编辑场景</button>
                {confirmDelExpert === exp.id ? (
                  <>
                    <button className="danger" onClick={() => deleteExpertScenario(exp)}>确认删除</button>
                    <button onClick={() => setConfirmDelExpert(null)}>取消</button>
                  </>
                ) : (
                  <button onClick={() => setConfirmDelExpert(exp.id)}>删除场景</button>
                )}
              </div>
            </>
          )}
        </div>
        <div className="grid">
          {draft.agents.map((a, idx) => (
            <div key={a.id} className="card">
              <div className="card-title">
                {editingExpert === exp.id && editingAgentIdx === idx ? (
                  <input className="inline-input" value={a.name} onChange={(e) => {
                    const agents = [...draft.agents];
                    agents[idx] = { ...agents[idx], name: e.target.value };
                    setExpertDraft({ ...draft, agents });
                  }} />
                ) : (
                  <strong>{a.name}</strong>
                )}
                {editingExpert !== exp.id || editingAgentIdx !== idx ? (
                  <span className="tag tag-live">{a.model}</span>
                ) : null}
              </div>
              {editingExpert === exp.id && editingAgentIdx === idx ? (
                <div className="expert-agent-form">
                  <label>模型
                    <select value={a.model} onChange={(e) => {
                      const agents = [...draft.agents];
                      agents[idx] = { ...agents[idx], model: e.target.value };
                      setExpertDraft({ ...draft, agents });
                    }}>
                      {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </label>
                  <label>描述
                    <textarea rows={2} value={a.description} onChange={(e) => {
                      const agents = [...draft.agents];
                      agents[idx] = { ...agents[idx], description: e.target.value };
                      setExpertDraft({ ...draft, agents });
                    }} />
                  </label>
                  <label>角色设定（首轮简报）
                    <textarea rows={5} value={a.briefing} onChange={(e) => {
                      const agents = [...draft.agents];
                      agents[idx] = { ...agents[idx], briefing: e.target.value };
                      setExpertDraft({ ...draft, agents });
                    }} />
                  </label>
                  <div className="check-row">
                    {(['memory', 'sessionRecall', 'knowledgeBase', 'generatedMedia', 'notion'] as const).map((cap) => (
                      <label key={cap}>
                        <input
                          type="checkbox"
                          checked={!!a.config?.[cap]?.enabled}
                          onChange={(e) => {
                            const agents = [...draft.agents];
                            agents[idx] = {
                              ...agents[idx],
                              config: { ...agents[idx].config, [cap]: { enabled: e.target.checked, ...(cap === 'memory' ? { provider: 'mem9', mem9: {} } : {}) } },
                            };
                            setExpertDraft({ ...draft, agents });
                          }}
                        />
                        {({ memory: '客户记忆', sessionRecall: '会话召回', knowledgeBase: '知识库', generatedMedia: '生成媒体', notion: 'Notion' } as any)[cap]}
                      </label>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  <p>{a.description}</p>
                  <div className="agent-id">Agent：{a.id} · 能力：{expertCaps(a).join(' / ') || '基础对话'}</div>
                  <details className="briefing">
                    <summary>角色设定（首轮简报）</summary>
                    <pre>{a.briefing}</pre>
                  </details>
                  {editingExpert !== exp.id && (
                    <div className="expert-assets">
                      {(() => {
                        const st = expertStats[a.id];
                        if (!st || st.status === 'loading') return <span className="hint">资产加载中…</span>;
                        if (st.status === 'missing') return <span className="hint">该专家尚未在 Agent9 创建，切换到专家后再查看资产。</span>;
                        return (
                          <>
                            <button className="asset-chip" onClick={() => setNav('plugins')}>🧩 Skills {st.skills}</button>
                            <button className="asset-chip" onClick={() => setNav('tools')}>🧰 工具 {st.tools}</button>
                            <button className="asset-chip" onClick={() => setNav('scheduled')}>⏰ 定时 {st.schedulers}</button>
                            <button className="asset-chip" onClick={() => { setNav('hub'); setHubTab('connectors'); }}>🌐 MCP {st.mcp}</button>
                            <button
                              className={`asset-chip ${st.inbound ? 'on' : ''}`}
                              onClick={() => { setNav('hub'); setHubTab('connectors'); }}
                            >
                              🔌 飞书{st.inbound ? ' 已开' : ' 关'}
                            </button>
                          </>
                        );
                      })()}
                    </div>
                  )}
                  {editingExpert !== exp.id &&
                    (() => {
                      const real = agents.find((x) => x.name === a.name && x.status === 'active');
                      return real ? (
                        <MemoryKnowledgePanel
                          agent={real}
                          client={client}
                          live={live}
                          onUpdated={refreshAgents}
                          onNotice={setNotice}
                        />
                      ) : null;
                    })()}
                </>
              )}
              <div className="actions">
                {editingExpert === exp.id && editingAgentIdx === idx ? (
                  <>
                    <button className="primary" onClick={saveExpertEdit}>保存</button>
                    <button onClick={cancelExpertEdit}>取消</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => useExpertAgent(a)}>切换到该专家</button>
                    <button onClick={() => startExpertAgentEdit(exp, idx)}>✎ 编辑 Agent</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </main>
    );
  };

  function startSessionEdit(row) {
    setEditingSessionId(row.sessionId);
    setSessionDraft(row.name ?? row.sessionId);
  }

  async function saveSessionEdit(sessionId) {
    const name = sessionDraft.trim();
    if (!name) {
      setEditingSessionId(null);
      setSessionDraft('');
      return;
    }
    try {
      if (live) await client.renameSession(sessionId, name);
      const list = sessions.map((s) => (s.sessionId === sessionId ? { ...s, name } : s));
      setSessions(list);
      if (selectedAgentId) persistSessions(selectedAgentId, list);
      if (selectedSession?.sessionId === sessionId) setSelectedSession({ ...selectedSession, name });
    } catch (err) {
      setNotice(`会话改名失败：${friendlyError(err)}`);
    }
    setEditingSessionId(null);
    setSessionDraft('');
  }

  const renderSessionRow = (s) => {
    const editing = editingSessionId === s.sessionId;
    return (
      <div
        key={s.sessionId}
        className={`session-row ${selectedSession?.sessionId === s.sessionId ? 'on' : ''}`}
        onClick={() => {
          if (!editing) loadSession(s);
        }}
        title={s.name ?? s.sessionId}
      >
        {editing ? (
          <input
            className="inline-input"
            value={sessionDraft}
            autoFocus
            onFocus={(e) => e.target.select()}
            onChange={(e) => setSessionDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveSessionEdit(s.sessionId);
              if (e.key === 'Escape') {
                setEditingSessionId(null);
                setSessionDraft('');
              }
            }}
            onBlur={() => saveSessionEdit(s.sessionId)}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            <span className="session-name">{s.name ?? s.sessionId}</span>
            <span className="session-tools">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  startSessionEdit(s);
                }}
                title="重命名会话"
              >
                ✎
              </button>
              <select
                className="mini-move"
                value={projects.sessionFolder[s.sessionId] ?? ''}
                title="移动到目录"
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => moveSession(s.sessionId, e.target.value || null)}
              >
                <option value="">📁</option>
                <option value="">🗂 未分类</option>
                {projects.folders.map((x) => (
                  <option key={x.id} value={x.id}>📁 {x.name}</option>
                ))}
              </select>
            </span>
          </>
        )}
      </div>
    );
  };

  // ---- Skill ----
  const loadAgentSkills = async () => {
    if (!live || !selectedAgentId) {
      setAgentSkills([]);
      return;
    }
    try {
      const res = await client.listAgentSkills(selectedAgentId);
      setAgentSkills(res?.skillInstallations ?? res ?? []);
    } catch {
      setAgentSkills([]);
    }
  };

  const viewSkillInstruction = async (s) => {
    if (skillInstructions[s.skillId]) return;
    try {
      const res = await client.getSkillFiles(s.skillId, s.version);
      const files = res?.files ?? res ?? [];
      const md = files.find((f) => f.path === 'SKILL.md' || f.path?.endsWith('/SKILL.md'));
      if (!md) throw new Error('未找到 SKILL.md');
      const text = await client.getSkillFile(s.skillId, s.version, md.path);
      setSkillInstructions((prev) => ({ ...prev, [s.skillId]: text || '（无内容）' }));
    } catch (err) {
      setNotice(`读取指令失败：${friendlyError(err)}`);
    }
  };

  async function uploadSkillZip() {
    const file = skillFileRef.current?.files?.[0];
    if (!file) {
      setAgentNotice('请先选择一个 SKILL ZIP 文件');
      return;
    }
    const scope = (document.querySelector('#skill-scope') as HTMLSelectElement | null)?.value ?? 'private';
    setSkillState({ stage: 'uploading', message: `上传 ${file.name} ...` });
    try {
      if (!live) {
        setSkillState({ stage: 'ready', skill: { skillId: 'skill_mock', name: file.name.replace(/\.zip$/i, ''), version: 1 }, message: 'Mock：Skill 已创建' });
        setAgentNotice('Mock：Skill 上传成功');
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = await client.uploadSkill({ scope, fileName: file.name, bytes });
      if (res?.skill) {
        setSkillState({ stage: 'ready', skill: res.skill, message: `Skill 已创建：${res.skill.name ?? res.skill.skillId}` });
        setAgentNotice(`Skill 创建成功：${res.skill.name ?? res.skill.skillId}`);
      } else if (res?.ingestion) {
        const etag = res._responseHeaders?.etag;
        setSkillState({ stage: 'confirm', ingestion: res.ingestion, etag, message: '包已暂存（告警确认），点击确认完成创建' });
        setAgentNotice('Skill 包已上传，等待确认');
      } else {
        throw new Error('上传响应无法识别');
      }
    } catch (err) {
      const isAuthoring = err?.code === 'skill_authoring_forbidden' || /cannot author Skills/i.test(err?.message ?? '');
      if (isAuthoring) {
        const consoleUrl = settings.baseUrl || proxyTarget || 'Agent9 Console';
        const msg =
          '上传 Skill 需要浏览器登录会话（Agent9 限制：API Key 不能创作 Skill）。\n' +
          `请打开 Agent9 内嵌 Console（${consoleUrl}）登录后在上传，或由具备浏览器会话的用户操作。`;
        setSkillState({ stage: 'error', message: msg });
        setAgentNotice('Skill 上传失败：需要浏览器登录会话（当前为 API Key 模式）');
      } else {
        setSkillState({ stage: 'error', message: friendlyError(err) });
        setAgentNotice(`Skill 上传失败：${friendlyError(err)}`);
      }
    }
  }

  async function confirmAndInstallSkill() {
    if (!skillState?.ingestion) return;
    try {
      const confirmed = await client.confirmSkillIngestion(skillState.ingestion.ingestionId, {
        ifMatch: skillState.etag,
      });
      const skill = confirmed?.skill;
      if (!skill) throw new Error('确认响应缺少 skill');
      setSkillState({ stage: 'ready', skill, message: `Skill 已确认：${skill.name ?? skill.skillId}` });
      if (selectedAgentId && live) {
        const etag = await agentEtag(selectedAgentId);
        await client.installSkillToAgent(
          selectedAgentId,
          { skillId: skill.skillId, version: skill.version ?? 1 },
          { ifMatch: etag },
        );
        setAgentNotice(`Skill 已安装到当前 Agent：${skill.name ?? skill.skillId}`);
        await loadAgentSkills();
      }
    } catch (err) {
      const isAuthoring = err?.code === 'skill_authoring_forbidden' || /cannot author Skills/i.test(err?.message ?? '');
      if (isAuthoring) {
        const consoleUrl = settings.baseUrl || proxyTarget || 'Agent9 Console';
        setSkillState({
          stage: 'error',
          message: `确认/安装 Skill 需要浏览器登录会话（API Key 不可用）。请打开 ${consoleUrl} 登录后操作。`,
        });
        setAgentNotice('Skill 确认/安装失败：需要浏览器登录会话');
      } else {
        setSkillState({ stage: 'error', message: friendlyError(err) });
        setAgentNotice(`确认/安装失败：${friendlyError(err)}`);
      }
    }
  }

  async function installReadySkill() {
    if (!skillState?.skill || !selectedAgentId) {
      setAgentNotice('请先选择 Agent');
      return;
    }
    try {
      const etag = await agentEtag(selectedAgentId);
      const skill = skillState.skill;
      await client.installSkillToAgent(
        selectedAgentId,
        { skillId: skill.skillId, version: skill.version ?? 1 },
        { ifMatch: etag },
      );
      setAgentNotice(`Skill 已安装到 ${selectedAgentId}`);
      await loadAgentSkills();
    } catch (err) {
      setAgentNotice(`安装失败：${friendlyError(err)}`);
    }
  }

  async function testConnection() {
    setAgentNotice('');
    try {
      await client.livez();
      await client.readyz();
      setAgentNotice(`连接正常 ✅ /livez、/readyz 均 OK（${!live ? 'Mock 模式未发请求' : settings.baseUrl || '经 Vite 代理'}）`);
    } catch (err) {
      setAgentNotice(`连接失败 ❌ ${friendlyError(err)}`);
    }
  }

  useEffect(() => {
    refreshAgents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  useEffect(() => {
    if (!live || !selectedAgentId || sessions.length === 0) return undefined;
    // 列表渲染后先在后台把近期会话历史拉进缓存，用户点击时即可秒开。
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        for (const session of sessions.slice(0, 10)) {
          if (cancelled) return;
          const sid = session.sessionId ?? session.id;
          if (!sid || historyCache.current.has(sid) || fullHistoryLoaded.current.has(sid)) continue;
          try {
            await fetchSessionBundle(sid);
          } catch {
            // 预取失败不提示，点击时会再按原路径加载。
          }
        }
      })();
    }, 900);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, selectedAgentId, sessions]);

  useEffect(() => {
    loadReminders();
    const timer = setInterval(() => loadReminders(), 60_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  useEffect(() => {
    if (configOpen && configTab === 'agents') loadDefaultAgent();
    if (nav === 'scheduled') loadSchedulers();
    if (nav === 'plugins') loadAgentSkills();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configOpen, configTab, nav, live]);

  useEffect(() => {
    if (nav.startsWith('expert:')) {
      const exp = experts.find((e) => e.id === nav.slice(7));
      exp?.agents.forEach((a) => {
        const real = agents.find((x) => x.name === a.name && x.status === 'active');
        loadExpertStats(a.id, real?.agentId ?? (live ? '' : null));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav, live]);

  const currentAgent = agents.find((a) => a.agentId === selectedAgentId);

  const renderCustomerDossier = (folderId) => {
    const folder = projects.folders.find((f) => f.id === folderId);
    if (!folder) {
      return (
        <main className="page">
          <p className="hint">客户档案不存在或已被删除。</p>
        </main>
      );
    }
    return (
      <CustomerDossier
        client={client}
        live={live}
        folder={folder}
        profile={projects.profiles?.[folderId] ?? {}}
        sessions={folderSessions(folderId)}
        onRename={(name) => renameFolderDirect(folderId, name)}
        onSaveProfile={(patch) => saveCustomerProfile(folderId, patch)}
        onOpenSession={(s) => loadSession(s)}
        onNewSession={() => createSession(folderId)}
        onAnalyzeFile={(file) => analyzeDriveFile(folderId, file)}
        onNotice={setNotice}
        resolveUrl={resolveUrl}
      />
    );
  };

  const renderChat = (
    <main className="chat">
      <div className="chat-main">
        <div className="scenarios">
          <span>售前场景：</span>
          {SCENARIOS.map((s) => (
            <button key={s.id} disabled={busy} onClick={() => sendTurn(s.prompt, s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <div
          className="thread"
          ref={threadRef}
          onScroll={() => {
            const el = threadRef.current;
            const all = messages.filter((m) => m.role !== 'system').length;
            if (el && el.scrollTop <= 24 && all - visibleCount > 0 && !olderBusyRef.current) {
              olderBusyRef.current = true;
              setVisibleCount((v) => v + 5);
              window.setTimeout(() => {
                olderBusyRef.current = false;
              }, 180);
            }
          }}
        >
          {messages.length === 0 && (
            <div className="empty">
              <h2>一个入口，覆盖售前全流程</h2>
              <p>需求分析 · 方案设计 · 竞品对比 · POC 准备 · 方案书 · 客户跟进</p>
              <p className="hint">
                当前 Agent：{currentAgent?.name ?? '未选择'}（{live ? 'Live' : 'Mock'}）
                {selectedSession ? ` · 会话 ${selectedSession.sessionId ?? selectedSession.id}` : ''}
              </p>
            </div>
          )}
          {(() => {
            const all = messages.filter((m) => m.role !== 'system');
            const hidden = Math.max(0, all.length - visibleCount);
            const shown = hidden > 0 ? all.slice(-visibleCount) : all;
            return (
              <>
                {hidden > 0 && (
                  <div className="history-hint">
                    继续向上滑动，每次加载更早 {Math.min(5, hidden)} 条
                  </div>
                )}
                {shown.map((m) => (
                  <ChatMessage
                    key={m.id ?? `${m.role}-${m.createdAt}`}
                    msg={m}
                    copied={copiedKey === `${m.role}-${m.id ?? m.createdAt ?? ''}`}
                    editing={editingMsg?.msg === m}
                    draft={editingMsg?.draft ?? ''}
                    onCopy={copyMessage}
                    onEdit={startEdit}
                    onDraft={onDraftChange}
                    onSave={saveEdit}
                    onCancel={cancelEdit}
                    client={client}
                    resolveUrl={resolveUrl}
                    live={live}
                    onError={setNotice}
                    onOpenSource={openMessageSource}
                  />
                ))}
              </>
            );
          })()}
          <div ref={bottomRef} />
        </div>
        <div className="composer">
          <div className="composer-inner">
            {attachments.length > 0 && (
              <div className="attach-chips">
                {attachments.map((a) => (
                  <span key={a.name} className={`attach-chip ${a.status === '就绪' || a.status === '就绪(Mock)' ? '' : 'attach-pending'}`}>
                    📎 {a.name} · {a.status}
                    {(a.status.startsWith('失败') || a.status === '就绪' || a.status === '就绪(Mock)') && (
                      <button className="chip-x" onClick={() => removeAttachment(a.name)}>×</button>
                    )}
                  </span>
                ))}
              </div>
            )}
            <textarea
              value={input}
              placeholder="输入问题，例如：帮我写一份 TiDB 迁移方案概要（可先点 📎 附加文件）"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submitChat();
                }
              }}
            />
            {voiceOn && (
              <div className="voice-hint">
                <span className="voice-dot" />
                正在聆听…讲完后点「停止语音」或直接按回车发送
              </div>
            )}
            <div className="composer-actions">
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.md,.csv,.png,.jpg,.jpeg,.webp"
                onChange={(e) => {
                  handleFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <button className="attach-btn" onClick={() => fileRef.current?.click()} title="附加文件（最多 3 个）">
                📎 附件
              </button>
              <button
                className={`attach-btn voice-btn${voiceOn ? ' voice-on' : ''}`}
                disabled={!speechSupported()}
                onClick={toggleVoiceInput}
                title={
                  speechSupported()
                    ? voiceOn
                      ? '停止语音输入'
                      : '开始语音输入（中文）'
                    : '当前浏览器不支持语音输入，请用 Chrome / Edge'
                }
              >
                {voiceOn ? '⏹ 停止语音' : '🎤 语音'}
              </button>
              <button disabled={busy} onClick={() => submitChat()}>
                {busy ? '思考中…' : '发送'}
              </button>
            </div>
          </div>
        </div>
      </div>
      {notice && <div className="notice chat-notice">{notice}</div>}
    </main>
  );

  const renderScheduled = (
    <main className="page">
      <div className="page-head">
        <h2>已安排 · 定时调度</h2>
        <p>定时任务（cron / 一次性）触发 Agent 自动执行并新开会话交付结果。</p>
        <div className="actions">
          <button onClick={startCreateScheduler}>
            {showSchedForm ? '收起表单' : '＋ 新建定时任务'}
          </button>
          <button onClick={loadSchedulers}>刷新</button>
        </div>
        {schedNotice && <div className="notice">{schedNotice}</div>}
      </div>

      {showSchedForm && (
        <div className="sched-form">
          <h3>{formSchedId ? '编辑定时任务' : '新建定时任务'}</h3>
          <label>定时任务名
            <input
              value={schedForm.name}
              placeholder="例如：示例客户每周跟进"
              onChange={(e) => setSchedForm({ ...schedForm, name: e.target.value })}
            />
          </label>
          <div className="sched-grid">
            <label>执行频率
              <select value={schedForm.freq} onChange={(e) => setSchedForm({ ...schedForm, freq: e.target.value })}>
                <option value="once">一次性</option>
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
                <option value="monthly">每月</option>
              </select>
            </label>
            {schedForm.freq === 'once' ? (
              <label>执行时间
                <input
                  type="datetime-local"
                  value={schedForm.runAt}
                  onChange={(e) => setSchedForm({ ...schedForm, runAt: e.target.value })}
                />
              </label>
            ) : (
              <>
                <label>执行时间
                  <input type="time" value={schedForm.time} onChange={(e) => setSchedForm({ ...schedForm, time: e.target.value })} />
                </label>
                {schedForm.freq === 'weekly' && (
                  <label>星期
                    <select value={schedForm.dow} onChange={(e) => setSchedForm({ ...schedForm, dow: e.target.value })}>
                      {Object.entries(DOW).map(([v, label]) => (
                        <option key={v} value={v}>{label}</option>
                      ))}
                    </select>
                  </label>
                )}
                {schedForm.freq === 'monthly' && (
                  <label>每月几号
                    <input
                      type="number"
                      min={1}
                      max={31}
                      value={schedForm.dom}
                      onChange={(e) => setSchedForm({ ...schedForm, dom: e.target.value })}
                    />
                  </label>
                )}
              </>
            )}
          </div>
          <label className="check-line">
            <input
              type="checkbox"
              checked={schedForm.notify}
              onChange={(e) => setSchedForm({ ...schedForm, notify: e.target.checked })}
            />
            <span>是否通知：执行完成后新开会话交付结果（生产环境通知走 Agent9 工作区 Webhook）</span>
          </label>
          <label>执行内容
            <textarea
              rows={4}
              value={schedForm.prompt}
              placeholder="每次执行时让 Agent 做什么，例如：回顾该客户在 TiDB 迁移咨询上的进展，输出跟进周报：未决问题、下一步建议、需准备的材料。"
              onChange={(e) => setSchedForm({ ...schedForm, prompt: e.target.value })}
            />
          </label>
          <div className="actions">
            <button className="primary" onClick={submitSchedulerForm}>{formSchedId ? '保存修改' : '创建'}</button>
            <button onClick={() => { setShowSchedForm(false); setFormSchedId(null); }}>取消</button>
          </div>
        </div>
      )}

      <div className="list">
        {schedulers.length === 0 && <p className="hint">暂无定时任务，点击「新建定时任务」创建</p>}
        {schedulers.map((s) => (
          <div key={s.schedulerId} className="list-row sched-row">
            <div className="sched-main">
              {editingSchedId === s.schedulerId ? (
                <input
                  className="inline-input"
                  value={schedDraft}
                  autoFocus
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setSchedDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveSchedRename(s.schedulerId);
                    if (e.key === 'Escape') {
                      setEditingSchedId(null);
                      setSchedDraft('');
                    }
                  }}
                  onBlur={() => saveSchedRename(s.schedulerId)}
                />
              ) : (
                <div className="sched-title">
                  <strong>{s.title ?? s.schedulerId}</strong>
                  <button className="icon-btn" onClick={() => startSchedRename(s)} title="重命名任务">✎</button>
                </div>
              )}
              <div className="agent-id">{s._label ?? (s.schedule?.kind === 'once' ? '一次性' : `cron ${s.schedule?.cronExpr ?? ''}`)} · {s.status}</div>
              {s.prompt && <p className="sched-prompt">{s.prompt.slice(0, 120)}{s.prompt.length > 120 ? '…' : ''}</p>}
            </div>
            <div className="sched-side">
              <label className="check-line" title="是否通知（执行后新开会话交付）">
                <input type="checkbox" checked={!!s._notify} onChange={() => toggleSchedNotify(s.schedulerId)} /> 通知
              </label>
              <button onClick={() => startEditScheduler(s)}>编辑</button>
              {confirmDelSched === s.schedulerId ? (
                <>
                  <button className="danger" onClick={() => confirmDeleteScheduler(s)}>确认删除</button>
                  <button onClick={() => setConfirmDelSched(null)}>取消</button>
                </>
              ) : (
                <button onClick={() => setConfirmDelSched(s.schedulerId)}>删除</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </main>
  );

  const renderReminders = (
    <main className="page">
      <div className="page-head">
        <h2>🔔 提醒中心</h2>
        <p>定时任务执行完成并生成新会话时，会作为未读提醒出现在这里（角标数字 = 未读数）。</p>
        <div className="actions">
          <button onClick={loadReminders}>刷新</button>
          <button onClick={markRemindersRead}>全部已读</button>
        </div>
        {notice && <div className="notice">{notice}</div>}
      </div>
      <div className="list">
        {reminders.length === 0 && <p className="hint">暂无提醒。创建定时任务并等它触发后，这里会出现新会话提醒。</p>}
        {reminders.map((r) => (
          <div key={r.fireId} className="list-row">
            <div>
              <strong>{r.title ?? r.schedulerId}</strong>
              <div className="agent-id">
                {new Date(r.scheduledFor).toLocaleString('zh-CN')} ·{' '}
                {r.executionStatus === 'completed' ? '已完成' : r.executionStatus === 'failed' ? '执行失败' : '待执行'}
                {r.webhookStatus ? ` · 通知：${({ pending: '待投递', delivered: '已投递', failed: '投递失败', cancelled: '已取消' } as any)[r.webhookStatus] ?? r.webhookStatus}` : ''}
              </div>
              {r.resultSessionId && <div className="agent-id">新会话：{r.resultSessionId}</div>}
            </div>
            {r.resultSessionId ? (
              <button onClick={() => loadSession({ sessionId: r.resultSessionId })}>打开会话</button>
            ) : (
              <span className={`tag ${r.executionStatus === 'failed' ? 'tag-mock' : 'tag-live'}`}>
                {r.executionStatus === 'failed' ? '执行失败' : '待执行'}
              </span>
            )}
          </div>
        ))}
      </div>
    </main>
  );

  const renderPlugins = (
    <main className="page">
      <div className="page-head">
        <h2>插件 · Skills</h2>
        <p>上传 SKILL ZIP（含 SKILL.md），创建后安装到当前 Agent。打包：<code>cd config/skill-tidb-presales && zip -r ../skill-tidb-presales.zip .</code></p>
        <p className="hint">
          ⚠ 注意：Skill 上传需要浏览器登录会话，API Key 模式会被 Agent9 拒绝（skill_authoring_forbidden）。
          可打开 Agent9 内嵌 Console（{settings.baseUrl || proxyTarget}）登录后在上传。
        </p>
        <div className="skill-form">
          <select id="skill-scope" defaultValue="private">
            <option value="private">private（个人）</option>
            <option value="workspace">workspace（工作区）</option>
          </select>
          <input ref={skillFileRef} type="file" accept=".zip" />
          <button onClick={uploadSkillZip} disabled={skillState?.stage === 'uploading'}>
            {skillState?.stage === 'uploading' ? '上传中…' : '上传 Skill'}
          </button>
          {skillState?.stage === 'confirm' && <button onClick={confirmAndInstallSkill}>确认并安装到当前 Agent</button>}
          {skillState?.stage === 'ready' && (
            <button onClick={installReadySkill}>
              安装到当前 Agent（{currentAgent?.name ?? selectedAgentId ?? '未选择'}）
            </button>
          )}
        </div>
        {skillState && <div className="notice">{skillState.message}</div>}
        {agentNotice && <div className="notice">{agentNotice}</div>}
      </div>

      <section className="ae-section">
        <h3>当前 Agent 可调用的技能（{agentSkills.length}）</h3>
        {!selectedAgentId && <p className="hint">请先在左上角选择 Agent。</p>}
        {selectedAgentId && agentSkills.length === 0 && (
          <p className="hint">该 Agent 尚未安装技能。上传并安装后，技能会出现在这里。</p>
        )}
        <div className="grid">
          {(live ? agentSkills : [
            {
              skillId: 'skill_mock_tidb',
              version: 1,
              scope: 'private',
              name: 'tidb-presales',
              description: 'TiDB 售前工作流：需求分析、方案设计、竞品对比、POC 准备、方案书/标书编写。',
              stableMountName: 'tidb-presales',
              instructionPath: 'SKILL.md',
              revision: 1,
            },
          ]).map((s) => (
            <div key={s.skillId} className="card">
              <div className="card-title">
                <strong>{s.name ?? s.skillId}</strong>
                <span className="tag tag-live">v{s.version}</span>
              </div>
              <p><strong className="skill-label">用途：</strong>{s.description || '（无描述）'}</p>
              <p className="skill-call">
                <strong className="skill-label">调用方式：</strong>
                对话中提出与「{s.name ?? s.skillId}」相关需求，Agent 自动发现匹配技能并读取指令后执行；
                挂载名 <code>{s.stableMountName ?? '-'}</code>，指令文件 <code>{s.instructionPath ?? '-'}</code>
                {s.scope === 'workspace' ? '（工作区技能）' : '（个人技能）'}
              </p>
              <details className="briefing" onToggle={(e) => { if (e.currentTarget.open) viewSkillInstruction(s); }}>
                <summary>查看指令（SKILL.md）</summary>
                <pre>{skillInstructions[s.skillId] ?? '加载中…'}</pre>
              </details>
            </div>
          ))}
        </div>
      </section>
    </main>
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">T</span>
          <span className="brand-name">tidbsa</span>
        </div>
        <div className="agent-picker">
          <select
            value={selectedAgentId}
            onChange={(e) => selectAgent(e.target.value)}
            title="切换 Agent（每个 Agent 的会话与项目相互独立）"
          >
            {!agents.length && <option value="">（无 Agent）</option>}
            {agents.map((a) => (
              <option key={a.agentId} value={a.agentId}>
                {a.name ?? a.agentId}
                {a.model ? ` · ${a.model}` : ''}
              </option>
            ))}
          </select>
        </div>
        <span className={`mode mode-${settings.mode}`}>{live ? 'Live' : 'Mock'}</span>
      </header>

      <div className="body">
        <aside className="sidebar">
          <div className="sidebar-scroll">
          <button className="new-chat" onClick={() => createSession()}>＋ 新对话</button>

          <div className="nav-section">
            <div className="nav-label">已安排</div>
            <button className={`nav-item ${nav === 'scheduled' ? 'on' : ''}`} onClick={() => setNav('scheduled')}>
              <span>⏰ 定时调度</span>
              {schedulers.length > 0 && <span className="badge">{schedulers.length}</span>}
            </button>
            <button
              className={`nav-item ${nav === 'reminders' ? 'on' : ''}`}
              onClick={() => {
                setNav('reminders');
                markRemindersRead();
              }}
            >
              <span>🔔 提醒</span>
              {unreadCount > 0 && <span className="badge badge-unread">{unreadCount > 99 ? '99+' : unreadCount}</span>}
            </button>
            <button className={`nav-item ${nav === 'webhook' ? 'on' : ''}`} onClick={() => setNav('webhook')}>
              <span>🔗 Webhook 通知</span>
            </button>
          </div>

          <div className="nav-section">
            <div className="nav-label">专家·连接器</div>
            <button
              className={`nav-item ${nav === 'hub' || nav.startsWith('expert:') ? 'on' : ''}`}
              onClick={() => setNav('hub')}
            >
              <span>🔌 专家·连接器</span>
              <span className="badge">{experts.length}</span>
            </button>
          </div>

          <div className="nav-section">
            <div className="nav-label">插件</div>
            <button className={`nav-item ${nav === 'plugins' ? 'on' : ''}`} onClick={() => setNav('plugins')}>
              <span>🧩 Skills</span>
            </button>
            <button className={`nav-item ${nav === 'tools' ? 'on' : ''}`} onClick={() => setNav('tools')}>
              <span>🧰 自定义工具</span>
            </button>
          </div>

          <div className="nav-section">
            <div className="nav-label">
              项目
              <button className="nav-add" onClick={createFolder} title="新建文件夹">＋</button>
            </div>
            {projects.folders.map((f) => (
              <div key={f.id} className="folder">
                <div className="folder-row">
                  {editingFolderId === f.id ? (
                    <input
                      className="inline-input folder-inline"
                      value={folderDraft}
                      autoFocus
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => setFolderDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveFolderEdit(f.id);
                        if (e.key === 'Escape') {
                          setEditingFolderId(null);
                          setFolderDraft('');
                        }
                      }}
                      onBlur={() => saveFolderEdit(f.id)}
                      placeholder="文件夹名称"
                    />
                  ) : (
                    <>
                      <button className="folder-toggle" onClick={() => toggleFolder(f.id)} title={expanded[f.id] === false ? '展开' : '折叠'}>
                        <span>{expanded[f.id] === false ? '▸' : '▾'} 📁 {f.name}</span>
                        <span className="badge">{folderSessions(f.id).length}</span>
                      </button>
                      <div className="folder-actions">
                        <button onClick={() => createSession(f.id)} title="在此新建对话">＋</button>
                        <button onClick={() => setNav(`folder:${f.id}`)} title="客户档案 / 资料库">📋</button>
                        <button onClick={() => startFolderEdit(f)} title="重命名文件夹">✎</button>
                        <button onClick={() => deleteFolder(f)} title="删除文件夹">🗑</button>
                      </div>
                    </>
                  )}
                </div>
                {expanded[f.id] !== false && renderSessionPreview(f.id, folderSessions(f.id))}
              </div>
            ))}
            <div className={`folder ${confirmDelUnfiled ? 'confirm-open' : ''}`}>
              <div className="folder-row">
                {editingFolderId === 'unfiled' ? (
                  <input
                    className="inline-input folder-inline"
                    value={folderDraft}
                    autoFocus
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setFolderDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveFolderEdit('unfiled');
                      if (e.key === 'Escape') {
                        setEditingFolderId(null);
                        setFolderDraft('');
                      }
                    }}
                    onBlur={() => saveFolderEdit('unfiled')}
                    placeholder="分组名称"
                  />
                ) : (
                  <>
                    <button className="folder-toggle" onClick={() => toggleFolder('unfiled')} title={expanded.unfiled === false ? '展开' : '折叠'}>
                      <span>{expanded.unfiled === false ? '▸' : '▾'} 🗂 {projects.unfiledName ?? '未分类'}</span>
                      <span className="badge">{unfiledSessions.length}</span>
                    </button>
                    <div className="folder-actions">
                      <button onClick={() => createSession(null)} title="在此新建对话">＋</button>
                      <button onClick={startUnfiledRename} title="重命名分组">✎</button>
                      {confirmDelUnfiled ? (
                        <>
                          <button onClick={deleteUnfiledSessions} title="确认清空分组会话">✓</button>
                          <button onClick={() => setConfirmDelUnfiled(false)} title="取消">✕</button>
                        </>
                      ) : (
                        <button onClick={() => setConfirmDelUnfiled(true)} title="清空分组内会话">🗑</button>
                      )}
                    </div>
                  </>
                )}
              </div>
              {expanded.unfiled !== false && renderSessionPreview('unfiled', unfiledSessions)}
            </div>
          </div>

          </div>
          <button className="config-btn" onClick={() => setConfigOpen(true)}>
            <span>⚙ 配置</span>
          </button>
        </aside>

        <div className="main">
          {agentEditorState ? (
            <AgentEditor
              mode={agentEditorState.mode}
              agentId={agentEditorState.agentId}
              client={client}
              live={live}
              onClose={closeAgentEditor}
              onSaved={onAgentSaved}
              onNotice={setNotice}
            />
          ) : (
            <>
              {nav.startsWith('folder:') && renderCustomerDossier(nav.slice(7))}
              {nav === 'chat' && renderChat}
              {nav === 'scheduled' && renderScheduled}
              {nav === 'reminders' && renderReminders}
              {nav === 'plugins' && renderPlugins}
              {nav === 'tools' && (
                <CustomToolsPage client={client} live={live} agents={agents} onNotice={setNotice} />
              )}
              {nav === 'webhook' && <WebhookPage client={client} live={live} onNotice={setNotice} />}
              {nav === 'hub' && renderHub}
              {nav.startsWith('expert:') && renderExpert(nav.slice(7))}
            </>
          )}
        </div>
      </div>

      {configOpen && (
        <div className="drawer-mask" onClick={() => setConfigOpen(false)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <h3>配置</h3>
              <button className="drawer-close" onClick={() => setConfigOpen(false)}>×</button>
            </div>
            <div className="drawer-tabs">
              {[['agents', 'Agent 管理'], ['cap', '能力全景'], ['settings', '设置']].map(([id, label]) => (
                <button key={id} className={configTab === id ? 'on' : ''} onClick={() => setConfigTab(id)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="drawer-body">
              {configTab === 'agents' && (
                <>
                  <div className="actions">
                    <button onClick={() => openAgentEditor('new')}>创建 Agent</button>
                    <button onClick={() => refreshAgents()}>刷新</button>
                  </div>
                  {agentNotice && <div className="notice">{agentNotice}</div>}
                  <table className="agent-table">
                    <thead>
                      <tr>
                        <th>名称</th><th>模型</th><th>状态</th><th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agents.map((a) => (
                        <tr key={a.agentId}>
                          <td>
                            <button className="linklike" onClick={() => { selectAgent(a.agentId); setConfigOpen(false); }}>
                              {a.name ?? a.agentId}
                            </button>
                            {a.agentId === defaultAgentId && <span className="default-badge">默认</span>}
                            <div className="agent-id">{a.agentId}</div>
                          </td>
                          <td>{a.model}</td>
                          <td>{a.status} · v{a.configVersion}</td>
                          <td>
                            <button onClick={() => openAgentEditor('edit', a.agentId)}>编辑</button>{' '}
                            <button onClick={() => setDefaultAgentRow(a)}>设为默认</button>{' '}
                            <button onClick={() => renameAgentRow(a)}>重命名</button>{' '}
                            <button onClick={() => archiveAgentRow(a)}>归档</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              {configTab === 'cap' && (
                <div className="grid">
                  {CAPABILITIES.map((c) => (
                    <div key={c.id} className="card">
                      <div className="card-title">
                        <strong>{c.name}</strong>
                        <span className={c.mock ? 'tag tag-mock' : 'tag tag-live'}>{c.mock ? 'Mock' : 'Live'}</span>
                      </div>
                      <p>{c.desc}</p>
                      <code>{c.api}</code>
                    </div>
                  ))}
                </div>
              )}
              {configTab === 'settings' && (
                <div className="settings">
                  <label>运行模式
                    <select value={settings.mode} onChange={(e) => saveSettings({ mode: e.target.value })}>
                      <option value="mock">Mock 演示（无需后端）</option>
                      <option value="live">Live（连接真实 Agent9）</option>
                    </select>
                  </label>
                  <label>Agent9 Base URL
                    <input value={settings.baseUrl ?? ''} placeholder="留空走 Vite 代理（无跨域）" onChange={(e) => saveSettings({ baseUrl: e.target.value })} />
                  </label>
                  <label>API Key
                    <input value={settings.apiKey ?? ''} placeholder="ag9_uak_..." onChange={(e) => saveSettings({ apiKey: e.target.value })} />
                  </label>
                  <label>Project ID
                    <input value={settings.projectId ?? ''} placeholder="留空自动取第一个项目" onChange={(e) => saveSettings({ projectId: e.target.value })} />
                  </label>
                  <div className="actions">
                    <button onClick={testConnection}>测试连接</button>
                  </div>
                  {agentNotice && <div className="notice">{agentNotice}</div>}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
