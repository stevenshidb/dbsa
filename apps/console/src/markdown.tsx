import { memo, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
const loadMermaid = () => {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      m.default.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'strict',
        fontFamily: 'inherit',
        themeVariables: { background: 'transparent' },
      });
      return m.default;
    });
  }
  return mermaidPromise;
};

function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const id = `mmd-${Math.random().toString(36).slice(2, 10)}`;
    setSvg('');
    setError('');
    loadMermaid()
      .then(async (mermaid) => {
        const { svg: out } = await mermaid.render(id, code);
        if (alive) setSvg(out);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [code]);

  if (error) {
    return (
      <pre className="mmd-fallback">
        <span className="mmd-error-label">流程图渲染失败：</span>
        {error}
        {'\n\n'}
        {code}
      </pre>
    );
  }
  if (!svg) {
    return <pre className="mmd-fallback">渲染流程图…</pre>;
  }
  return <div className="mermaid-box" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/**
 * LLM 输出渲染：Markdown（GFM：表格/列表/代码块）+ ```mermaid 流程图。
 * diagrams=false（流式草稿）时不渲染流程图，只显示原文代码块，避免流式阶段频繁重渲染。
 */
export const MarkdownView = memo(function MarkdownView({
  text,
  diagrams = true,
}: {
  text: string;
  diagrams?: boolean;
}) {
  const parts = useMemo(() => {
    const out: Array<{ kind: 'md' | 'mermaid'; text: string }> = [];
    const re = /```mermaid\s*\n([\s\S]*?)(```|$)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ kind: 'md', text: text.slice(last, m.index) });
      out.push({ kind: 'mermaid', text: m[1] });
      last = re.lastIndex;
    }
    if (last < text.length) out.push({ kind: 'md', text: text.slice(last) });
    return out;
  }, [text]);

  return (
    <div className="markdown-body">
      {parts.map((p, i) =>
        p.kind === 'mermaid' && diagrams ? (
          <MermaidBlock key={i} code={p.text} />
        ) : (
          <ReactMarkdown key={i} remarkPlugins={[remarkGfm]}>
            {p.text}
          </ReactMarkdown>
        ),
      )}
    </div>
  );
});
