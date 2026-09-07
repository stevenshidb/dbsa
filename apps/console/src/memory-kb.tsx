import { useState } from 'react';

const friendly = (err) => err?.message ?? String(err);

function capabilityConfig(cap, enabled) {
  if (cap === 'memory') return { enabled, provider: 'mem9', mem9: {} };
  return { enabled };
}

export default function MemoryKnowledgePanel({
  agent,
  client,
  live,
  onUpdated,
  onNotice,
}) {
  const [keyDraft, setKeyDraft] = useState('');
  const [busyCap, setBusyCap] = useState('');
  const [busyKey, setBusyKey] = useState(false);

  const cfg = agent?.config ?? {};
  const memory = cfg.memory ?? {};
  const memEnabled = memory.enabled === true;
  const hasMemKey = memory.mem9?.hasKey === true;
  const recallEnabled = cfg.sessionRecall?.enabled === true;
  const kbEnabled = cfg.knowledgeBase?.enabled === true;
  const notionEnabled = cfg.notion?.enabled === true;

  const etagFor = async () => {
    const res = await client.getAgent(agent.agentId);
    const etag = res?._responseHeaders?.etag;
    if (!etag) throw new Error('未取到 Agent ETag');
    return etag;
  };

  const toggleCap = async (cap, enabled) => {
    if (!live) {
      onNotice?.('Mock 模式：记忆/知识源开关仅用于预览');
      return;
    }
    setBusyCap(cap);
    try {
      const etag = await etagFor();
      await client.patchAgentConfig(agent.agentId, { [cap]: capabilityConfig(cap, enabled) }, { ifMatch: etag });
      await onUpdated?.();
      onNotice?.(
        cap === 'memory'
          ? `客户记忆已${enabled ? '开启' : '关闭'}`
          : cap === 'sessionRecall'
            ? `会话召回已${enabled ? '开启' : '关闭'}`
            : cap === 'knowledgeBase'
              ? `团队知识库使用已${enabled ? '开启' : '关闭'}`
              : `Notion 使用已${enabled ? '开启' : '关闭'}`,
      );
    } catch (err) {
      onNotice?.(`更新失败：${friendly(err)}`);
    } finally {
      setBusyCap('');
    }
  };

  const bindKey = async () => {
    const key = keyDraft.trim();
    if (!key) return onNotice?.('请先粘贴 Mem9 Key');
    if (!live) {
      onNotice?.('Mock 模式：不真实绑定');
      return;
    }
    setBusyKey(true);
    try {
      await client.putMem9Key(agent.agentId, key);
      setKeyDraft('');
      await onUpdated?.();
      onNotice?.('Mem9 Key 已校验并绑定');
    } catch (err) {
      onNotice?.(`Mem9 Key 绑定失败：${friendly(err)}`);
    } finally {
      setBusyKey(false);
    }
  };

  const Switch = ({ on, label, disabled }) => (
    <button disabled={disabled || busyCap !== ''} onClick={() => toggleCap(label, !on)}>
      {on ? '关闭' : '开启'}
    </button>
  );

  return (
    <details className="mem-kb-panel">
      <summary>🧠 记忆 · 团队知识源（Agent9 实配）</summary>
      <div className="mem-kb-grid">
        <div className="mem-kb-row">
          <div className="mem-kb-main">
            <strong>客户记忆（Mem9）</strong>
            <span className="agent-id">
              {memEnabled ? '已开启' : '已关闭'} · {hasMemKey ? 'Key 已绑定' : 'Key 未绑定'}
              {memory.mem9?.ownershipState ? ` · ${memory.mem9.ownershipState}` : ''}
            </span>
          </div>
          <Switch on={memEnabled} label="memory" disabled={false} />
        </div>
        {memEnabled && (
          <div className="mem-kb-key">
            <input
              type="password"
              value={keyDraft}
              placeholder={hasMemKey ? '粘贴新 Mem9 Key 以轮换（可选）' : '粘贴 Mem9 Key 后绑定'}
              onChange={(e) => setKeyDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') bindKey(); }}
            />
            <button disabled={busyKey || !keyDraft.trim()} onClick={bindKey}>
              {hasMemKey ? '轮换 Key' : '绑定 Key'}
            </button>
          </div>
        )}

        <div className="mem-kb-row">
          <div className="mem-kb-main">
            <strong>会话召回</strong>
            <span className="agent-id">跨会话回忆该客户历史沟通</span>
          </div>
          <Switch on={recallEnabled} label="sessionRecall" disabled={false} />
        </div>

        <div className="mem-kb-row">
          <div className="mem-kb-main">
            <strong>团队知识库（KB）</strong>
            <span className="agent-id">回答时引用团队方案/案例/模板资料</span>
          </div>
          <Switch on={kbEnabled} label="knowledgeBase" disabled={false} />
        </div>

        <div className="mem-kb-row">
          <div className="mem-kb-main">
            <strong>Notion 资料库</strong>
            <span className="agent-id">读取用户授权的 Notion 页面/资料</span>
          </div>
          <Switch on={notionEnabled} label="notion" disabled={false} />
        </div>
      </div>
      <p className="hint">
        KB/Notion 的“数据源连接”需要在 Agent9 Console 用浏览器登录（工作区管理员）配置；
        这里控制的是该专家 Agent 是否使用这些能力。回答引用记忆/KB 时，来源会显示在消息下方。
      </p>
    </details>
  );
}
