import { useEffect, useMemo, useState } from 'react';

const MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5', 'DeepSeek-V4-Flash'];
const LARK_BASES = [
  { value: 'https://open.feishu.cn', label: '飞书（feishu.cn）' },
  { value: 'https://open.larksuite.com', label: 'Lark（larksuite.com）' },
];

const DEFAULT_FORM = {
  name: '新 Agent',
  model: 'DeepSeek-V4-Flash',
  sandboxProfile: 'standard-v1',
  runtimeBackend: 'pi',
  authId: '',
  memory: true,
  sessionRecall: true,
  knowledgeBase: true,
  generatedMedia: false,
  notion: false,
  lark: false,
  larkBaseUrl: 'https://open.feishu.cn',
  larkAppId: '',
  larkAppSecret: '',
  managedTools: [], // { name, version, packageDigest }
  skillIds: [], // 创建时随 Agent 安装
};

const friendly = (err) => err?.message ?? String(err);

export default function AgentEditor({ mode, agentId, client, live, onClose, onSaved, onNotice }) {
  const [form, setForm] = useState({ ...DEFAULT_FORM });
  const [loaded, setLoaded] = useState(mode !== 'edit');
  const [installedSkills, setInstalledSkills] = useState([]);
  const [skillCatalog, setSkillCatalog] = useState([]);
  const [installTarget, setInstallTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!live) {
      setSkillCatalog([]);
      setInstalledSkills([]);
      return;
    }
    Promise.allSettled([client.listSkills('private'), client.listSkills('workspace')])
      .then((results) => {
        const merged = results.flatMap((r) =>
          r.status === 'fulfilled' ? r.value?.skills ?? r.value ?? [] : [],
        );
        const seen = new Set();
        setSkillCatalog(merged.filter((s) => (seen.has(s.skillId) ? false : (seen.add(s.skillId), true))));
      })
      .catch(() => {});
    if (mode === 'edit' && agentId) {
      client
        .getAgent(agentId)
        .then((res) => {
          const a = res?.agent ?? res;
          const c = a.config ?? {};
          setForm({
            name: a.name ?? a.agentId,
            model: a.model,
            sandboxProfile: a.sandboxProfile ?? 'standard-v1',
            runtimeBackend: c.runtime?.backend ?? 'pi',
            authId: c.runtime?.authId ?? '',
            memory: c.memory?.enabled ?? false,
            sessionRecall: c.sessionRecall?.enabled ?? false,
            knowledgeBase: c.knowledgeBase?.enabled ?? true,
            generatedMedia: c.generatedMedia?.enabled ?? false,
            notion: c.notion?.enabled ?? false,
            lark: !!c.lark?.enabled,
            larkBaseUrl: c.lark?.apiBaseUrl ?? 'https://open.feishu.cn',
            larkAppId: c.lark?.appId ?? '',
            larkAppSecret: c.lark?.appSecret ?? '',
            managedTools: c.tools?.managed ?? [],
            skillIds: [],
          });
          setLoaded(true);
        })
        .catch((err) => {
          setNotice(`加载 Agent 失败：${friendly(err)}`);
          setLoaded(true);
        });
      client
        .listAgentSkills(agentId)
        .then((res) => setInstalledSkills(res?.skillInstallations ?? res ?? []))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, agentId, live]);

  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));

  const managedPatch = (idx, patch) =>
    set({ managedTools: form.managedTools.map((t, i) => (i === idx ? { ...t, ...patch } : t)) });

  const buildConfig = () => ({
    runtime: form.runtimeBackend === 'codex' ? { backend: 'codex', authId: form.authId } : { backend: 'pi' },
    memory: { enabled: form.memory, provider: 'mem9', mem9: {} },
    sessionRecall: { enabled: form.sessionRecall },
    knowledgeBase: { enabled: form.knowledgeBase },
    generatedMedia: { enabled: form.generatedMedia },
    notion: { enabled: form.notion },
    ...(form.lark
      ? {
          lark: {
            apiBaseUrl: form.larkBaseUrl,
            appId: form.larkAppId,
            appSecret: form.larkAppSecret,
            enabled: true,
          },
        }
      : {}),
    tools: { managed: form.managedTools },
  });

  const save = async () => {
    if (!form.name.trim()) return setNotice('请填写 Agent 名称');
    if (form.runtimeBackend === 'codex' && !form.authId) return setNotice('Codex Runtime 需要 authId');
    if (form.lark && (!form.larkAppId || !form.larkAppSecret)) return setNotice('启用飞书需要填写 App ID 与 App Secret');
    setBusy(true);
    setNotice('');
    try {
      if (!live) {
        onSaved?.('agent_mock', form.name.trim());
        return;
      }
      if (mode === 'new') {
        const res = await client.createAgent(
          {
            name: form.name.trim(),
            model: form.model,
            config: buildConfig(),
            ...(form.skillIds.length ? { skillInstallations: form.skillIds.map((sid) => ({ skillId: sid, version: 1 })) } : {}),
          },
          { idempotencyKey: `tidbsa-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
        );
        const created = res?.agent ?? res;
        onSaved?.(created.agentId, created.name);
        return;
      }
      // edit
      const etag = (await client.getAgent(agentId))?._responseHeaders?.etag;
      if (!etag) throw new Error('未取到 Agent ETag');
      if (form.name.trim() !== (await client.getAgent(agentId))?.agent?.name) {
        const cur = await client.getAgent(agentId);
        const curEtag = cur?._responseHeaders?.etag;
        await client.renameAgent(agentId, form.name.trim(), { ifMatch: curEtag });
      }
      const fresh = await client.getAgent(agentId);
      await client.patchAgentConfig(agentId, buildConfig(), { ifMatch: fresh._responseHeaders?.etag });
      onSaved?.(agentId, form.name.trim());
    } catch (err) {
      setNotice(`保存失败：${friendly(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const installSkill = async () => {
    if (!installTarget) return;
    const skill = skillCatalog.find((s) => s.skillId === installTarget);
    if (!skill) return;
    setBusy(true);
    try {
      const agent = await client.getAgent(agentId);
      await client.installSkillToAgent(
        agentId,
        { skillId: skill.skillId, version: skill.headVersion ?? 1 },
        { ifMatch: agent._responseHeaders?.etag },
      );
      setNotice(`已安装 Skill：${skill.name ?? skill.skillId}`);
      const res = await client.listAgentSkills(agentId);
      setInstalledSkills(res?.skillInstallations ?? res ?? []);
      setInstallTarget('');
    } catch (err) {
      setNotice(`安装失败：${friendly(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const Section = ({ title, children }) => (
    <section className="ae-section">
      <h3>{title}</h3>
      {children}
    </section>
  );

  return (
    <main className="page agent-editor">
      <div className="page-head">
        <h2>{mode === 'new' ? '创建 Agent' : `编辑 Agent：${agentId}`}</h2>
        <p>完整配置 Agent 的基础信息、工具、记忆、知识库与 Skills。</p>
        {notice && <div className="notice">{notice}</div>}
      </div>

      {!loaded ? (
        <p className="hint">加载中…</p>
      ) : (
        <>
          <Section title="基础信息">
            <div className="ae-grid">
              <label>名称
                <input value={form.name} onChange={(e) => set({ name: e.target.value })} />
              </label>
              <label>模型
                <select value={form.model} onChange={(e) => set({ model: e.target.value })}>
                  {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <label>沙箱 Profile
                <input value={form.sandboxProfile} onChange={(e) => set({ sandboxProfile: e.target.value })} />
              </label>
              <label>Runtime 后端
                <select value={form.runtimeBackend} onChange={(e) => set({ runtimeBackend: e.target.value })}>
                  <option value="pi">pi（默认）</option>
                  <option value="codex">codex（需 authId）</option>
                </select>
              </label>
              {form.runtimeBackend === 'codex' && (
                <label>Codex authId
                  <input value={form.authId} placeholder="auth_..." onChange={(e) => set({ authId: e.target.value })} />
                </label>
              )}
            </div>
          </Section>

          <Section title="配置工具">
            <div className="ae-grid">
              <label className="check-line">
                <input type="checkbox" checked={form.sessionRecall} onChange={(e) => set({ sessionRecall: e.target.checked })} />
                <span>会话召回（跨会话历史）</span>
              </label>
              <label className="check-line">
                <input type="checkbox" checked={form.knowledgeBase} onChange={(e) => set({ knowledgeBase: e.target.checked })} />
                <span>知识库（案例 / FAQ / 白皮书）</span>
              </label>
              <label className="check-line">
                <input type="checkbox" checked={form.generatedMedia} onChange={(e) => set({ generatedMedia: e.target.checked })} />
                <span>生成媒体（图片 / 视频）</span>
              </label>
              <label className="check-line">
                <input type="checkbox" checked={form.notion} onChange={(e) => set({ notion: e.target.checked })} />
                <span>Notion（文档沉淀）</span>
              </label>
              <label className="check-line">
                <input type="checkbox" checked={form.lark} onChange={(e) => set({ lark: e.target.checked })} />
                <span>飞书（Lark）</span>
              </label>
              {form.lark && (
                <>
                  <label>飞书平台
                    <select value={form.larkBaseUrl} onChange={(e) => set({ larkBaseUrl: e.target.value })}>
                      {LARK_BASES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                    </select>
                  </label>
                  <label>App ID
                    <input value={form.larkAppId} placeholder="cli_..." onChange={(e) => set({ larkAppId: e.target.value })} />
                  </label>
                  <label>App Secret
                    <input type="password" value={form.larkAppSecret} onChange={(e) => set({ larkAppSecret: e.target.value })} />
                  </label>
                </>
              )}
            </div>
            <div className="ae-managed">
              <div className="ae-managed-head">
                <strong>Managed Tools（受管外部工具）</strong>
                <button onClick={() => set({ managedTools: [...form.managedTools, { name: 'managed_', version: 1, packageDigest: '' }] })}>
                  ＋ 添加
                </button>
              </div>
              {form.managedTools.map((t, i) => (
                <div key={i} className="ae-managed-row">
                  <input value={t.name} placeholder="managed_xxx" onChange={(e) => managedPatch(i, { name: e.target.value })} />
                  <input type="number" min={1} value={t.version} onChange={(e) => managedPatch(i, { version: Number(e.target.value) || 1 })} />
                  <input value={t.packageDigest} placeholder="64位十六进制 digest" onChange={(e) => managedPatch(i, { packageDigest: e.target.value })} />
                  <button onClick={() => set({ managedTools: form.managedTools.filter((_, x) => x !== i) })}>移除</button>
                </div>
              ))}
              <p className="hint">Managed Tool 需先在 Agent9 工作区安装对应包，名称/版本/digest 需与服务端一致。</p>
            </div>
          </Section>

          <Section title="记忆（Mem9）">
            <div className="ae-grid">
              <label className="check-line">
                <input type="checkbox" checked={form.memory} onChange={(e) => set({ memory: e.target.checked })} />
                <span>启用客户记忆（Mem9，长期记忆自动写入/召回）</span>
              </label>
            </div>
          </Section>

          <Section title="Skills">
            {mode === 'edit' ? (
              <>
                <div className="ae-skills">
                  {installedSkills.length === 0 && <p className="hint">尚未安装 Skill</p>}
                  {installedSkills.map((s) => (
                    <span key={s.skillId} className="skill-pill">
                      {s.canonicalName ?? s.skillId} · v{s.versionNumber ?? s.version}
                    </span>
                  ))}
                </div>
                {live && skillCatalog.length > 0 && (
                  <div className="ae-install">
                    <select value={installTarget} onChange={(e) => setInstallTarget(e.target.value)}>
                      <option value="">选择要安装的 Skill…</option>
                      {skillCatalog.map((s) => (
                        <option key={s.skillId} value={s.skillId}>
                          {s.name ?? s.skillId}（v{s.headVersion ?? 1}）
                        </option>
                      ))}
                    </select>
                    <button disabled={busy || !installTarget} onClick={installSkill}>安装</button>
                  </div>
                )}
                <p className="hint">需要新 Skill？前往「插件 → Skills」上传后回来安装。</p>
              </>
            ) : (
              <>
                <p className="hint">创建时可选装已有 Skill（也可创建后在此编辑页安装）：</p>
                {!live ? (
                  <p className="hint">Mock 模式不加载 Skill 目录。</p>
                ) : skillCatalog.length === 0 ? (
                  <p className="hint">暂无可用 Skill，可先到「插件」上传。</p>
                ) : (
                  <div className="ae-skills">
                    {skillCatalog.map((s) => (
                      <label key={s.skillId} className="skill-check">
                        <input
                          type="checkbox"
                          checked={form.skillIds.includes(s.skillId)}
                          onChange={(e) =>
                            set({
                              skillIds: e.target.checked
                                ? [...form.skillIds, s.skillId]
                                : form.skillIds.filter((x) => x !== s.skillId),
                            })
                          }
                        />
                        {s.name ?? s.skillId}（v{s.headVersion ?? 1}）
                      </label>
                    ))}
                  </div>
                )}
              </>
            )}
          </Section>

          <div className="ae-actions">
            <button className="primary" disabled={busy} onClick={save}>
              {busy ? '保存中…' : mode === 'new' ? '创建 Agent' : '保存修改'}
            </button>
            <button onClick={onClose}>取消</button>
          </div>
        </>
      )}
    </main>
  );
}
