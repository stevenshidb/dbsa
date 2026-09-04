import { useEffect, useRef, useState } from 'react';

const friendly = (err) => err?.message ?? String(err);

const MOCK_TOOLS = [
  {
    toolVersionId: 'ct_mock_1',
    scope: 'workspace',
    reference: { name: 'price-lookup', version: 1, packageDigest: 'a'.repeat(64) },
    displayName: '报价查询工具',
    description: '查询内部报价系统，返回含税区间。',
    status: 'published',
    mountedOnAgent: true,
    credentials: [],
    allowedHosts: ['https://quote.internal.example'],
  },
  {
    toolVersionId: 'ct_mock_2',
    scope: 'personal',
    reference: { name: 'competitor-tracker', version: 2, packageDigest: 'b'.repeat(64) },
    displayName: '竞品动态抓取',
    description: '定时抓取竞品官网与公众号动态。',
    status: 'draft',
    mountedOnAgent: false,
    credentials: [{ env: 'COMPETITOR_TOKEN', label: '抓取凭据', description: '', ownerMode: 'shared' }],
    allowedHosts: [],
  },
];

export function CustomToolsPage({ client, live, agents, onNotice }) {
  const [tools, setTools] = useState([]);
  const [scope, setScope] = useState('personal');
  const fileRef = useRef(null);
  const [configOpen, setConfigOpen] = useState(null); // toolVersionId
  const [policyDraft, setPolicyDraft] = useState({}); // toolId -> { env: mode }
  const [credValues, setCredValues] = useState({}); // `${toolId}:${env}` -> value
  const [mountTarget, setMountTarget] = useState({}); // toolId -> agentId
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!live) {
      setTools(MOCK_TOOLS);
      return;
    }
    try {
      const res = await client.listCustomTools();
      setTools(res?.tools ?? res ?? []);
    } catch (err) {
      onNotice?.(`加载自定义工具失败：${friendly(err)}`);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  const run = async (label, fn) => {
    setBusy(true);
    try {
      await fn();
      onNotice?.(`${label}成功`);
      await load();
    } catch (err) {
      onNotice?.(`${label}失败：${friendly(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const upload = () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return onNotice?.('请先选择 ZIP');
    run('上传', async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (live) await client.uploadCustomTool({ scope, fileName: file.name, bytes });
    });
  };

  const credKey = (tid, env) => `${tid}:${env}`;

  return (
    <main className="page">
      <div className="page-head">
        <h2>🧰 自定义工具</h2>
        <p>上传团队自己的沙箱工具（ZIP 内含 manifest.json 与 index.mjs），配置凭据与策略后发布、挂载到 Agent。</p>
        <div className="skill-form">
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="personal">personal（个人）</option>
            <option value="workspace">workspace（工作区，需管理员）</option>
          </select>
          <input ref={fileRef} type="file" accept=".zip" />
          <button disabled={busy} onClick={upload}>{busy ? '处理中…' : '上传工具'}</button>
          <button onClick={load}>刷新</button>
        </div>
        <p className="hint">工具 ZIP ≤1GiB；依赖需自行打包（Agent9 不安装依赖）。</p>
      </div>

      <div className="list">
        {tools.length === 0 && <p className="hint">暂无自定义工具{live ? '' : '（Mock 示例已隐藏，切换 Live 查看真实数据）'}。</p>}
        {tools.map((t) => (
          <div key={t.toolVersionId} className="list-row ct-row">
            <div className="ct-main">
              <div className="sched-title">
                <strong>{t.displayName ?? t.reference?.name ?? t.toolVersionId}</strong>
                <span className="tag tag-live">{t.status === 'published' ? '已发布' : '草稿'}</span>
                {t.mountedOnAgent && <span className="tag tag-mock">已挂载</span>}
                <span className="tag tag-mock">{t.scope}</span>
              </div>
              <div className="agent-id">v{t.reference?.version} · {t.reference?.name} · {t.toolVersionId}</div>
              {t.description && <p className="sched-prompt">{t.description}</p>}
              <div className="agent-id">
                凭据：{(t.credentials ?? []).map((c) => `${c.env}(${c.ownerMode ?? '?'})`).join('、') || '无'}
                {(t.allowedHosts ?? []).length ? ` · 出口：${(t.allowedHosts ?? []).join(', ')}` : ''}
              </div>
            </div>
            <div className="ct-actions">
              {t.status === 'draft' && (
                <button onClick={() => run('发布', async () => { if (live) await client.publishCustomTool(t.toolVersionId); })}>发布</button>
              )}
              {t.status === 'published' && !t.mountedOnAgent && (
                <>
                  <select value={mountTarget[t.toolVersionId] ?? ''} onChange={(e) => setMountTarget((p) => ({ ...p, [t.toolVersionId]: e.target.value }))}>
                    <option value="">挂载到…</option>
                    {agents.map((a) => <option key={a.agentId} value={a.agentId}>{a.name ?? a.agentId}</option>)}
                  </select>
                  <button
                    disabled={!mountTarget[t.toolVersionId]}
                    onClick={() =>
                      run('挂载', async () => {
                        if (live) await client.mountCustomTool(t.toolVersionId, mountTarget[t.toolVersionId]);
                      })
                    }
                  >
                    挂载
                  </button>
                </>
              )}
              {(t.credentials ?? []).length > 0 && t.status === 'draft' && (
                <button onClick={() => setConfigOpen(configOpen === t.toolVersionId ? null : t.toolVersionId)}>
                  {configOpen === t.toolVersionId ? '收起配置' : '配置凭据/策略'}
                </button>
              )}
              {t.status === 'draft' && (
                <button onClick={() => run('删除', async () => { if (live) await client.deleteCustomTool(t.toolVersionId); })}>删除</button>
              )}
            </div>
            {configOpen === t.toolVersionId && (
              <div className="ct-config">
                {(t.credentials ?? []).map((c) => (
                  <div key={c.env} className="ct-cred-row">
                    <div>
                      <strong>{c.label || c.env}</strong>
                      <div className="agent-id">{c.env} · 当前策略：{policyDraft[t.toolVersionId]?.[c.env] ?? c.ownerMode ?? 'shared'}</div>
                    </div>
                    <select
                      value={policyDraft[t.toolVersionId]?.[c.env] ?? c.ownerMode ?? 'shared'}
                      onChange={(e) => {
                        const cur = policyDraft[t.toolVersionId] ?? {};
                        setPolicyDraft((p) => ({ ...p, [t.toolVersionId]: { ...cur, [c.env]: e.target.value } }));
                      }}
                    >
                      <option value="shared">shared（共享）</option>
                      <option value="user">user（个人）</option>
                    </select>
                    <button
                      disabled={busy}
                      onClick={() =>
                        run('保存策略', async () => {
                          if (live) {
                            await client.setCustomToolPolicy(t.toolVersionId, {
                              [c.env]: policyDraft[t.toolVersionId]?.[c.env] ?? c.ownerMode ?? 'shared',
                            });
                          }
                        })
                      }
                    >
                      保存策略
                    </button>
                    <input
                      type="password"
                      placeholder="凭据值（≥8 字符）"
                      value={credValues[credKey(t.toolVersionId, c.env)] ?? ''}
                      onChange={(e) => setCredValues((p) => ({ ...p, [credKey(t.toolVersionId, c.env)]: e.target.value }))}
                    />
                    <button
                      disabled={busy || !(credValues[credKey(t.toolVersionId, c.env)] ?? '')}
                      onClick={() =>
                        run('连接凭据', async () => {
                          if (live) {
                            await client.connectCustomToolCredential(
                              t.toolVersionId,
                              c.env,
                              credValues[credKey(t.toolVersionId, c.env)],
                            );
                          }
                        })
                      }
                    >
                      连接
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}

export function WebhookPage({ client, live, onNotice }) {
  const [webhook, setWebhook] = useState(null);
  const [etag, setEtag] = useState('');
  const [createdSecret, setCreatedSecret] = useState('');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [notice, setNotice] = useState('');
  const [authHint, setAuthHint] = useState('');

  const load = async () => {
    if (!live) {
      setWebhook({ webhookId: 'wh_mock', endpointUrl: 'https://hooks.internal/agent9', status: 'disabled', algorithm: 'HMAC-SHA256', revision: 1 });
      return;
    }
    try {
      const res = await client.getSchedulerWebhook();
      setWebhook(res?.webhook ?? res ?? null);
      setEtag(res?._responseHeaders?.etag ?? '');
      setAuthHint('');
      if (webhook && endpointUrl === '') setEndpointUrl(res?.webhook?.endpointUrl ?? '');
    } catch (err) {
      setWebhook(null);
      setAuthHint(friendly(err));
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  const act = async (label, fn) => {
    try {
      await fn();
      setNotice(`${label}成功`);
      await load();
    } catch (err) {
      setNotice(`${label}失败：${friendly(err)}`);
    }
  };

  return (
    <main className="page">
      <div className="page-head">
        <h2>🔔 Webhook 通知</h2>
        <p>配置工作区级 Webhook：定时任务执行完成后，Agent9 会以 HMAC-SHA256 签名推送事件到你指定的 HTTPS 地址。</p>
        {authHint && <div className="notice">⚠ {authHint}。该接口需要 Workspace API Key（billing 管理）或浏览器会话。</div>}
        {notice && <div className="notice">{notice}</div>}
      </div>
      <div className="connector-card">
        <div className="card-title">
          <strong>当前 Webhook</strong>
          {webhook ? <span className={`tag ${webhook.status === 'enabled' ? 'tag-live' : 'tag-mock'}`}>{webhook.status}</span> : <span className="tag tag-mock">未配置</span>}
        </div>
        {webhook ? (
          <>
            <p className="hint">Endpoint：{webhook.endpointUrl} · 算法 {webhook.algorithm} · 版本 {webhook.revision}</p>
            <div className="actions">
              <button onClick={() => act(webhook.status === 'enabled' ? '停用' : '启用', () => client.patchSchedulerWebhook(webhook.status !== 'enabled', { ifMatch: etag }))}>
                {webhook.status === 'enabled' ? '停用' : '启用'}
              </button>
              <button onClick={() => act('删除', () => client.deleteSchedulerWebhook({ ifMatch: etag }))}>删除</button>
            </div>
          </>
        ) : (
          <div className="skill-form">
            <input placeholder="https://your-system.example/hook" value={endpointUrl} onChange={(e) => setEndpointUrl(e.target.value)} />
            <button disabled={!endpointUrl} onClick={() => act('创建', async () => {
              const res = await client.createSchedulerWebhook(endpointUrl.trim());
              setCreatedSecret(res?.webhook?.secret ?? '');
            })}>
              创建
            </button>
          </div>
        )}
        {createdSecret && (
          <div className="notice">一次性签名密钥（请立即保存）：<code>{createdSecret}</code></div>
        )}
        <p className="hint">定时任务的「通知」开关会按此 Webhook 推送事件（Agent9 #927 已增强事件内容）。</p>
      </div>
    </main>
  );
}
