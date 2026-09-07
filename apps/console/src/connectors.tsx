import { useEffect, useState } from 'react';
import { McpSection } from './mcp';
import LakeConnector from './lake';

const LARK_BASES = [
  { value: 'https://open.feishu.cn', label: '飞书（feishu.cn）' },
  { value: 'https://open.larksuite.com', label: 'Lark（larksuite.com）' },
];

const friendly = (err) => err?.message ?? String(err);

export default function Connectors({ client, live, agents, selectedAgentId, onNotice }) {
  const [form, setForm] = useState({ apiBaseUrl: 'https://open.feishu.cn', appId: '', appSecret: '', enabled: true });
  const [mcpRefresh, setMcpRefresh] = useState(0);
  const [catalog, setCatalog] = useState([]);
  const [selected, setSelected] = useState([]);
  const [status, setStatus] = useState('未连接');
  const [busy, setBusy] = useState(false);
  const [inbound, setInbound] = useState({ enabled: false, status: 'disabled', notice: '' });

  const loadTools = async () => {
    if (!live) {
      setStatus('Mock：未连接（可在 Live 模式查看真实配置）');
      setCatalog([]);
      setSelected([]);
      return;
    }
    try {
      const res = await client.getLarkTools();
      const caps = res?.capabilities ?? [];
      setCatalog(caps);
      const enabled = res?.enabledCapabilityIds?.length
        ? res.enabledCapabilityIds
        : caps.filter((c) => c.recommended).map((c) => c.itemId);
      setSelected(enabled);
      setStatus(res?.hasDefaultCapability ? '已配置 · 可生成授权链接' : '未配置 · 请先保存应用配置');
    } catch (err) {
      setStatus('读取配置失败');
      onNotice?.(`读取飞书配置失败：${friendly(err)}`);
    }
  };

  useEffect(() => {
    loadTools();
    loadInbound();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, selectedAgentId]);

  const loadInbound = async () => {
    if (!live || !selectedAgentId) {
      setInbound({ enabled: false, status: 'disabled', notice: !live ? 'Mock：未开启' : '请先选择 Agent' });
      return;
    }
    try {
      const res = await client.getLarkInbound(selectedAgentId);
      setInbound({ enabled: !!res?.enabled, status: res?.status ?? 'disabled', notice: '' });
    } catch (err) {
      setInbound({ enabled: false, status: 'error', notice: friendly(err) });
    }
  };

  const toggleInbound = async (enabled) => {
    setBusy(true);
    try {
      if (!live) {
        setInbound({ enabled, status: enabled ? 'enabled' : 'disabled', notice: 'Mock：已' + (enabled ? '开启' : '关闭') });
        return;
      }
      const res = await client.setLarkInbound(selectedAgentId, enabled);
      setInbound({ enabled: res?.enabled !== false, status: res?.status ?? (enabled ? 'enabled' : 'disabled'), notice: `已${enabled ? '开启' : '关闭'} Agent 飞书入站频道` });
    } catch (err) {
      setInbound((p) => ({ ...p, notice: `${enabled ? '开启' : '关闭'}失败：${friendly(err)}` }));
    } finally {
      setBusy(false);
    }
  };

  const agentEtag = async (agentId) => {
    const res = await client.getAgent(agentId);
    const etag = res?._responseHeaders?.etag;
    if (!etag) throw new Error('未取到 Agent ETag');
    return etag;
  };

  const saveToAgent = async () => {
    setBusy(true);
    try {
      if (!live) {
        onNotice?.('Mock：应用配置已保存');
        return;
      }
      const agentId = selectedAgentId || agents[0]?.agentId;
      if (!agentId) throw new Error('请先选择 Agent');
      const etag = await agentEtag(agentId);
      await client.patchAgentConfig(
        agentId,
        {
          lark: {
            apiBaseUrl: form.apiBaseUrl,
            appId: form.appId,
            appSecret: form.appSecret,
            enabled: form.enabled,
          },
        },
        { ifMatch: etag },
      );
      setStatus('已配置 · 可生成授权链接');
      onNotice?.('飞书应用配置已保存到当前 Agent');
      await loadTools();
    } catch (err) {
      onNotice?.(`保存失败：${friendly(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const saveCoverage = async () => {
    setBusy(true);
    try {
      if (!live) {
        onNotice?.('Mock：能力配置已保存');
        return;
      }
      await client.patchLarkCapability(selected);
      onNotice?.(`已启用 ${selected.length} 项飞书能力`);
    } catch (err) {
      onNotice?.(`保存能力失败：${friendly(err)}。请先完成「保存到当前 Agent」配置应用。`);
    } finally {
      setBusy(false);
    }
  };

  const authorize = async () => {
    setBusy(true);
    try {
      if (!live) {
        onNotice?.('Mock：授权链接已生成（演示）');
        return;
      }
      const agentId = selectedAgentId || agents[0]?.agentId;
      if (!agentId) throw new Error('请先选择 Agent');
      const res = await client.getLarkAuthorizeUrl(agentId);
      const url = res?.authorizationUrl ?? res?.url ?? (typeof res === 'string' ? res : null);
      if (!url) throw new Error('响应中没有授权链接');
      window.open(url, '_blank');
      onNotice?.('已在新窗口打开飞书授权页，授权完成后回到 Agent9 即可使用');
    } catch (err) {
      onNotice?.(`生成授权链接失败：${friendly(err)}。授权接口需要浏览器登录会话，请在浏览器登录 Agent9 后操作。`);
    } finally {
      setBusy(false);
    }
  };

  const toggleCap = (id) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  return (
    <div className="connectors">
      <div className="connector-card">
        <div className="card-title">
          <strong>飞书（Lark）</strong>
          <span className={`tag ${status.startsWith('已配置') ? 'tag-live' : 'tag-mock'}`}>{status}</span>
        </div>
        <p className="hint">
          三步连接：① 在飞书开放平台创建应用并配置回调 → ② 填写应用凭据并保存到当前 Agent → ③ 生成授权链接完成用户授权。
        </p>
        <div className="conn-form">
          <label>平台
            <select value={form.apiBaseUrl} onChange={(e) => setForm({ ...form, apiBaseUrl: e.target.value })}>
              {LARK_BASES.map((b) => (
                <option key={b.value} value={b.value}>{b.label}</option>
              ))}
            </select>
          </label>
          <label>App ID
            <input value={form.appId} placeholder="cli_..." onChange={(e) => setForm({ ...form, appId: e.target.value })} />
          </label>
          <label>App Secret
            <input type="password" value={form.appSecret} placeholder="应用密钥" onChange={(e) => setForm({ ...form, appSecret: e.target.value })} />
          </label>
          <label className="check-line">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            <span>启用飞书能力</span>
          </label>
          <div className="actions">
            <button disabled={busy} onClick={saveToAgent}>保存到当前 Agent</button>
            <button disabled={busy} onClick={authorize}>生成授权链接</button>
          </div>
        </div>
      </div>

      <div className="connector-card">
        <div className="card-title">
          <strong>飞书能力范围</strong>
          <span className="tag tag-live">已选 {selected.length}</span>
        </div>
        <p className="hint">勾选允许 Agent 使用的飞书能力（推荐项默认选中），保存后按用户授权生效。</p>
        {catalog.length === 0 && !live && <p className="hint">Mock 模式不加载真实能力目录。</p>}
        <div className="cap-list">
          {catalog.map((c) => (
            <label key={c.itemId} className="cap-item">
              <input type="checkbox" checked={selected.includes(c.itemId)} onChange={() => toggleCap(c.itemId)} />
              <span>
                <strong>{c.featureArea}</strong> · {c.description}
                {c.recommended ? '（推荐）' : ''}
              </span>
            </label>
          ))}
        </div>
        <div className="actions">
          <button disabled={busy} onClick={saveCoverage}>保存能力配置</button>
        </div>
      </div>

      <div className="connector-card">
        <div className="card-title">
          <strong>飞书入站频道（在飞书里与 Agent 对话）</strong>
          <span className={`tag ${inbound.enabled ? 'tag-live' : 'tag-mock'}`}>
            {inbound.status === 'enabled' ? '已开启' : inbound.status === 'not_configured' ? '未配置' : inbound.status === 'disabled' ? '已关闭' : inbound.status}
          </span>
        </div>
        <p className="hint">
          开启后，用户可在飞书内与当前 Agent 直接对话（Agent9 #819）。前置：完成上方应用配置与用户授权。
        </p>
        {!selectedAgentId && <p className="hint">请先在左上角选择 Agent。</p>}
        {inbound.notice && <p className="hint">{inbound.notice}</p>}
      {selectedAgentId && (
        <div className="actions">
            {!inbound.enabled ? (
              <button disabled={busy} onClick={() => toggleInbound(true)}>开启频道</button>
            ) : (
              <button disabled={busy} onClick={() => toggleInbound(false)}>关闭频道</button>
            )}
          </div>
        )}
      </div>

      <LakeConnector
        client={client}
        live={live}
        agents={agents}
        selectedAgentId={selectedAgentId}
        onNotice={onNotice}
        onChanged={() => setMcpRefresh((v) => v + 1)}
      />
      <McpSection
        client={client}
        live={live}
        agents={agents}
        onNotice={onNotice}
        refreshToken={mcpRefresh}
      />
    </div>
  );
}
