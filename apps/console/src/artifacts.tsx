import { useEffect, useState } from 'react';

const fmtSize = (n) => {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

/** 会话产物卡片：图片内联预览 + 下载（通过 Agent9 公开下载票据）。 */
export default function ArtifactCard({ artifact, client, resolveUrl, live, onError }) {
  const [url, setUrl] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!live) return;
    let alive = true;
    client
      .mintArtifactDownloadUrl(artifact.artifactId, artifact.revisionId)
      .then((r) => {
        if (alive) setUrl(resolveUrl(r.url));
      })
      .catch((e) => {
        if (alive) setErr(e?.message ?? String(e));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact.artifactId, artifact.revisionId, live]);

  const isImage = artifact.kind === 'image' || /^image\//.test(artifact.mimeType ?? '');
  return (
    <div className="artifact-card">
      {isImage && (
        <div className="artifact-img-wrap">
          {live && url ? (
            <img className="artifact-img" src={url} alt={artifact.name} />
          ) : (
            <span className="artifact-img-ph">🖼</span>
          )}
        </div>
      )}
      <div className="artifact-info">
        <span className="artifact-name" title={artifact.name}>{artifact.name}</span>
        <span className="artifact-meta">
          {fmtSize(artifact.byteSize)}
          {artifact.mimeType ? ` · ${artifact.mimeType}` : ''}
        </span>
        {err && <span className="artifact-err">⚠ {err}</span>}
      </div>
      <div className="artifact-actions">
        {live ? (
          url ? (
            <a className="artifact-download" href={url} target="_blank" rel="noreferrer">
              ⬇ 下载
            </a>
          ) : (
            <span className="artifact-meta">准备中…</span>
          )
        ) : (
          <span className="artifact-meta">Mock 产物</span>
        )}
      </div>
    </div>
  );
}
