import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const friendly = (err) => err?.message ?? String(err);

const MOCK_FILES = [
  { name: '客户需求记录.md', relPath: 'mock/客户需求记录.md', size: 1820, modifiedAt: new Date().toISOString(), type: 'markdown', sessionId: 'mock' },
  { name: 'POC 方案 v3.docx', relPath: 'mock/POC 方案 v3.docx', size: 245760, modifiedAt: new Date().toISOString(), type: 'other', sessionId: 'mock' },
  { name: '迁移架构图.png', relPath: 'mock/迁移架构图.png', size: 655360, modifiedAt: new Date().toISOString(), type: 'image', sessionId: 'mock' },
];

const MOCK_ARTIFACTS = [
  { artifactId: 'art_mock_1', revisionId: 'rev_mock_1', name: '方案概要.md', kind: 'document', byteSize: 2048, createdAt: new Date().toISOString() },
  { artifactId: 'art_mock_2', revisionId: 'rev_mock_2', name: 'POC 用例清单.xlsx', kind: 'data', byteSize: 18432, createdAt: new Date(Date.now() - 86400000).toISOString() },
];

const FILE_ICONS = {
  markdown: '📝', image: '🖼', pdf: '📕', archive: '🗜', data: '📊',
  code: '🧩', audio: '🎧', video: '🎬', text: '📄', folder: '📁', other: '📎',
};

const EMPTY_PROFILE = {
  company: '',
  industry: '',
  stage: '初步接触',
  status: '跟进中',
  owner: '',
  notes: '',
};

const formatBytes = (n) => {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

export default function CustomerDossier({
  client,
  live,
  folder,
  profile,
  sessions,
  onRename,
  onSaveProfile,
  onOpenSession,
  onNewSession,
  onAnalyzeFile,
  onNotice,
  resolveUrl,
}) {
  const [draft, setDraft] = useState({ ...EMPTY_PROFILE, ...profile });
  const [projectId, setProjectId] = useState(client.projectId ?? '');
  const [driveFiles, setDriveFiles] = useState([]);
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveError, setDriveError] = useState('');
  const [driveRefresh, setDriveRefresh] = useState(0);
  const [recentArtifacts, setRecentArtifacts] = useState([]);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const cancelRef = useRef(0);

  useEffect(() => {
    setDraft({ ...EMPTY_PROFILE, ...profile });
  }, [profile]);

  const sessionKey = sessions
    .map((s) => s.sessionId ?? s.id ?? '')
    .filter((x) => x.startsWith('sess_'))
    .sort()
    .join('|');
  const folderSessions = useMemo(
    () =>
      sessions.filter((s) => (s.sessionId ?? s.id ?? '').startsWith('sess_')),
    // sessionKey 只在会话集合真正变化时改变，避免父组件每次渲染触发重复拉取。
    [sessionKey], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const ensureProject = useCallback(async () => {
    if (projectId) return projectId;
    if (!live) return '';
    try {
      const res = await client.listProjects();
      const list = res?.projects ?? res ?? [];
      const first = list[0]?.projectId ?? '';
      if (!first) throw new Error('当前 API Key 下没有可用项目');
      client.projectId = first;
      setProjectId(first);
      return first;
    } catch (err) {
      throw new Error(`解析项目失败：${friendly(err)}`);
    }
  }, [client, live, projectId]);

  const loadDrive = useCallback(async () => {
    const token = ++cancelRef.current;
    setDriveLoading(true);
    setDriveError('');
    try {
      if (!live) {
        setDriveFiles(MOCK_FILES);
        return;
      }
      const pid = await ensureProject();
      if (!pid || folderSessions.length === 0) {
        setDriveFiles([]);
        return;
      }
      const out = [];
      for (const session of folderSessions) {
        if (token !== cancelRef.current) return;
        const sessionPath = session.sessionId ?? session.id;
        const root = await client.listDriveDirectory(pid, { path: sessionPath });
        for (const file of root?.files ?? []) {
          out.push({ ...file, sessionId: sessionPath, source: sessionPath.slice(0, 18) });
        }
        // Drive 以会话为目录；只下沉一层子目录，避免无限递归。
        for (const dir of root?.folders ?? []) {
          if (token !== cancelRef.current) return;
          const nested = await client.listDriveDirectory(pid, { path: dir.relPath });
          for (const file of nested?.files ?? []) {
            out.push({
              ...file,
              sessionId: sessionPath,
              source: `${sessionPath.slice(0, 18)}/${dir.name}`,
            });
          }
        }
      }
      out.sort((a, b) => String(b.modifiedAt ?? '').localeCompare(String(a.modifiedAt ?? '')));
      setDriveFiles(out);
    } catch (err) {
      setDriveError(`读取客户资料失败：${friendly(err)}`);
    } finally {
      if (token === cancelRef.current) setDriveLoading(false);
    }
  }, [client, ensureProject, folderSessions, live]);

  const loadRecentArtifacts = useCallback(async () => {
    if (!live) {
      setRecentArtifacts(MOCK_ARTIFACTS);
      return;
    }
    if (folderSessions.length === 0) {
      setRecentArtifacts([]);
      return;
    }
    setArtifactsLoading(true);
    try {
      const pid = await ensureProject();
      if (!pid) return;
      const turnIds = new Set();
      for (const session of folderSessions) {
        const sessionPath = session.sessionId ?? session.id;
        const turns = await client.listTurns(sessionPath);
        for (const t of turns?.turns ?? turns ?? []) {
          if (t?.id) turnIds.add(t.id);
        }
      }
      const artifacts = await client.listArtifacts({ limit: 100 });
      const items = artifacts?.artifacts ?? [];
      const rows = [];
      for (const item of items) {
        const art = item?.artifact ?? item;
        const rev = item?.revision ?? {};
        if (!rev.sourceTurnId || !turnIds.has(rev.sourceTurnId)) continue;
        rows.push({
          artifactId: art?.artifactId,
          revisionId: rev.revisionId,
          name: rev.safeName ?? art?.displayName ?? '产物',
          kind: art?.kind ?? 'other',
          mimeType: rev.mimeType ?? '',
          byteSize: rev.byteSize ?? 0,
          createdAt: art?.createdAt ?? '',
        });
      }
      rows.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
      setRecentArtifacts(rows.slice(0, 30));
    } catch (err) {
      // 产物归档是增强能力，失败不阻塞资料库。
      setRecentArtifacts([]);
    } finally {
      setArtifactsLoading(false);
    }
  }, [client, ensureProject, folderSessions, live]);

  useEffect(() => {
    loadDrive();
    loadRecentArtifacts();
    setPreview(null);
    setSearchResults([]);
    return () => {
      cancelRef.current += 1;
    };
  }, [folder?.id, live, driveRefresh, loadDrive, loadRecentArtifacts]);

  const download = async (file) => {
    try {
      if (!live) {
        onNotice?.('Mock 模式：文件下载不生效');
        return;
      }
      const pid = await ensureProject();
      const res = await client.mintDriveDownloadUrl(pid, file.relPath);
      if (!res?.url) throw new Error('未拿到下载票据');
      window.open(resolveUrl(res.url), '_blank', 'noopener');
    } catch (err) {
      onNotice?.(`下载失败：${friendly(err)}`);
    }
  };

  const downloadArtifact = async (item) => {
    try {
      if (!live) {
        onNotice?.('Mock 模式：产物下载不生效');
        return;
      }
      const res = await client.mintArtifactDownloadUrl(item.artifactId, item.revisionId);
      if (!res?.url) throw new Error('未拿到下载票据');
      window.open(resolveUrl(res.url), '_blank', 'noopener');
    } catch (err) {
      onNotice?.(`下载产物失败：${friendly(err)}`);
    }
  };

  const openPreview = async (file) => {
    setPreview({ file, kind: 'loading', content: null });
    try {
      if (!live) {
        setPreview({ file, kind: 'text', content: `# ${file.name}\n\nMock 预览：这里会展示该资料的内容。`, markdown: true });
        return;
      }
      const pid = await ensureProject();
      const res = await client.readDriveFile(pid, file.relPath);
      if (res?.kind === 'image') {
        const dl = await client.mintDriveDownloadUrl(pid, file.relPath);
        setPreview({ file, kind: 'image', url: dl?.url ? resolveUrl(dl.url) : null });
      } else if (res?.content) {
        setPreview({ file, kind: 'text', content: res.content, markdown: !!res.markdown });
      } else if (res?.kind === 'download') {
        setPreview({ file, kind: 'download', content: null });
      } else {
        throw new Error('该文件暂不支持在线预览，可直接下载');
      }
    } catch (err) {
      setPreview({ file, kind: 'error', content: null, error: friendly(err) });
    }
  };

  const runSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    try {
      if (!live) {
        setSearchResults(
          MOCK_FILES.filter((f) => f.name.toLowerCase().includes(q.toLowerCase())).map((f) => ({
            ...f,
            score: 1,
          })),
        );
        return;
      }
      const pid = await ensureProject();
      const res = await client.searchDriveProject(pid, { q, mode: 'name', limit: 50 });
      const allowed = new Set(folderSessions.map((s) => s.sessionId ?? s.id));
      const rows = (res?.results ?? [])
        .filter((r) => allowed.has((r.relPath ?? '').split('/')[0]))
        .slice(0, 30)
        .map((r) => ({ ...r, sessionId: r.relPath.split('/')[0] }));
      setSearchResults(rows.map((r) => ({ ...r, source: String(r.relPath.split('/')[0] ?? '').slice(0, 18) })));
    } catch (err) {
      onNotice?.(`搜索失败：${friendly(err)}`);
    } finally {
      setSearching(false);
    }
  };

  const commitProfile = (patch) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onSaveProfile?.(patch);
  };

  const displayFiles = searchResults.length ? searchResults : driveFiles;
  const fileIcon = (type) => FILE_ICONS[type] ?? FILE_ICONS.other;
  const fmtTime = (s) => (s ? new Date(s).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }) : '');

  return (
    <main className="page dossier-page">
      <div className="page-head">
        <h2>
          📋 客户档案
          <span className="folder-name-inline">{folder?.name ?? ''}</span>
        </h2>
        <p>客户会话、资料文件与元数据统一在这里维护；点会话进入对话继续协作。</p>
      </div>

      <div className="customer-meta">
        <label>客户/项目名
          <input
            value={folder?.name ?? ''}
            onChange={(e) => {
              const name = e.target.value;
              onRename?.(name || '未命名客户');
            }}
          />
        </label>
        <label>公司
          <input value={draft.company ?? ''} placeholder="客户公司全称" onChange={(e) => setDraft({ ...draft, company: e.target.value })} onBlur={() => onSaveProfile?.({ company: draft.company })} />
        </label>
        <label>行业
          <input value={draft.industry ?? ''} placeholder="金融/零售/制造/互联网…" onChange={(e) => setDraft({ ...draft, industry: e.target.value })} onBlur={() => onSaveProfile?.({ industry: draft.industry })} />
        </label>
        <label>阶段
          <select value={draft.stage ?? ''} onChange={(e) => setDraft({ ...draft, stage: e.target.value })} onBlur={() => onSaveProfile?.({ stage: draft.stage })}>
            {['初步接触', '需求沟通', '技术交流', 'POC', '方案评审', '商务谈判', '已成交'].map((x) => <option key={x}>{x}</option>)}
          </select>
        </label>
        <label>状态
          <select value={draft.status ?? ''} onChange={(e) => setDraft({ ...draft, status: e.target.value })} onBlur={() => onSaveProfile?.({ status: draft.status })}>
            {['跟进中', '暂缓', '已放弃', '已成交'].map((x) => <option key={x}>{x}</option>)}
          </select>
        </label>
        <label>负责人
          <input value={draft.owner ?? ''} placeholder="售前/销售负责人" onChange={(e) => setDraft({ ...draft, owner: e.target.value })} onBlur={() => onSaveProfile?.({ owner: draft.owner })} />
        </label>
        <label className="customer-notes">
          备注
          <textarea rows={2} value={draft.notes ?? ''} placeholder="客户背景、关键干系人、下一步动作…" onChange={(e) => setDraft({ ...draft, notes: e.target.value })} onBlur={() => onSaveProfile?.({ notes: draft.notes })} />
        </label>
      </div>

      <div className="dossier-body">
        <section className="dossier-col dossier-sessions">
          <div className="card-title">
            <strong>客户会话</strong>
            <span className="tag tag-live">{folderSessions.length}</span>
          </div>
          {folderSessions.length === 0 && <p className="hint">暂无会话。先新建一个对话，归档文件会自动出现在“资料文件”。</p>}
          {folderSessions.map((s) => (
            <button key={s.sessionId ?? s.id} className="list-row clickable" onClick={() => onOpenSession?.(s)}>
              <span className="dossier-session-name">{s.name ?? `会话 ${(s.sessionId ?? s.id).slice(-6)}`}</span>
              <span className="agent-id">{fmtTime(s.createdAt) || ''}</span>
            </button>
          ))}
          <div className="actions">
            <button className="primary" onClick={onNewSession}>＋ 新建客户会话</button>
          </div>
        </section>

        <section className="dossier-col dossier-files">
          <div className="card-title">
            <strong>资料文件（Drive）</strong>
            <span className="tag tag-live">{displayFiles.length}</span>
          </div>
          <div className="drive-search">
            <input
              value={query}
              placeholder="搜索该客户会话资料…"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
            />
            <button disabled={searching} onClick={runSearch}>搜索</button>
            {query && <button onClick={() => { setQuery(''); setSearchResults([]); }}>清除</button>}
          </div>
          <button className="text-link" onClick={() => setDriveRefresh((v) => v + 1)} disabled={driveLoading}>
            {driveLoading ? '刷新中…' : '↻ 刷新资料'}
          </button>
          {driveError && <p className="hint dossier-error">{driveError}</p>}
          {driveLoading && <p className="hint">正在聚合该客户的会话文件…</p>}
          {!driveLoading && displayFiles.length === 0 && (
            <p className="hint">暂无资料文件。该客户会话中 Agent 产出/用户上传的文件会自动出现在这里。</p>
          )}
          <div className="drive-file-list">
            {displayFiles.map((f) => (
              <div key={`${f.relPath}-${f.size}`} className="drive-file-row">
                <span className="drive-file-ic">{fileIcon(f.type)}</span>
                <div className="drive-file-main">
                  <strong>{f.name}</strong>
                  <div className="agent-id">{f.source ?? ''} · {formatBytes(f.size)} · {fmtTime(f.modifiedAt)}</div>
                </div>
                <div className="ct-actions">
                  <button onClick={() => openPreview(f)} title="预览">👁 预览</button>
                  <button onClick={() => onAnalyzeFile?.(f)} title="让 Agent 阅读并分析这份资料">🤖 分析</button>
                  <button onClick={() => download(f)} title="下载">⬇</button>
                </div>
              </div>
            ))}
          </div>

          {preview && (
            <div className="drive-preview">
              <div className="card-title">
                <strong>预览：{preview.file?.name}</strong>
                <button className="chip-x" onClick={() => setPreview(null)}>×</button>
              </div>
              {preview.kind === 'loading' && <p className="hint">读取中…</p>}
              {preview.kind === 'text' && preview.markdown && (
                <div className="drive-preview-md" dangerouslySetInnerHTML={{ __html: simpleMarkdown(preview.content) }} />
              )}
              {preview.kind === 'text' && !preview.markdown && <pre className="drive-preview-text">{preview.content}</pre>}
              {preview.kind === 'image' && preview.url && <img className="drive-preview-img" src={preview.url} alt={preview.file?.name} />}
              {preview.kind === 'download' && <p className="hint">二进制/大文件不支持内联预览，请点下载。</p>}
              {preview.kind === 'error' && <p className="hint dossier-error">{preview.error}</p>}
            </div>
          )}
        </section>
      </div>

      <section className="artifact-archive">
        <div className="card-title">
          <strong>产出物归档</strong>
          <span className="tag tag-live">{recentArtifacts.length}</span>
          <button className="text-link" onClick={loadRecentArtifacts} disabled={artifactsLoading}>
            {artifactsLoading ? '刷新中…' : '↻ 刷新'}
          </button>
        </div>
        {artifactsLoading && <p className="hint">正在汇总该客户会话的 Agent 产出物…</p>}
        {!artifactsLoading && recentArtifacts.length === 0 && (
          <p className="hint">暂无已发布产物。Agent 生成并发布的文件（方案、图片、文档）会自动归档到这里。</p>
        )}
        <div className="artifact-grid">
          {recentArtifacts.map((a) => (
            <div key={`${a.artifactId}-${a.revisionId}`} className="artifact-card">
              <strong>{a.name}</strong>
              <div className="agent-id">{a.kind} · {formatBytes(a.byteSize)} · {fmtTime(a.createdAt)}</div>
              <div className="artifact-actions">
                <button className="artifact-download" onClick={() => downloadArtifact(a)}>⬇ 下载</button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function simpleMarkdown(text) {
  const escaped = String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .replace(/^###### (.*)$/gm, '<h6>$1</h6>')
    .replace(/^##### (.*)$/gm, '<h5>$1</h5>')
    .replace(/^#### (.*)$/gm, '<h4>$1</h4>')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(\r?\n){2,}/g, '</p><p>')
    .replace(/\r?\n/g, '<br />')
    .replace(/^\s*<p>|<\/p>\s*$/g, '');
}
