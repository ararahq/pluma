import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { Link } from "../lib/router";
import { Arrow, Check, Download } from "./Icons";

const samples = {
  memo: `---
title: "Weekly research brief"
author: "Northstar Labs"
---

# A calmer way to ship agent output

Example data — Pluma turns Markdown into a document people can review, forward, and trust.

## This week

- **18 sources** reviewed
- **3 decisions** ready for approval
- **1 risk** needs an owner

> The deliverable is part of the product.

## Recommendation

Keep the pipeline in Markdown. Render the artifact at the boundary.`,
  proposal: `---
title: "Implementation proposal"
author: "Northstar Labs"
---

# Document automation, without a browser

Example data — prepared for **Atlas Works** · August 2026

## Scope

1. Generate the proposal in Markdown
2. Apply brand tokens automatically
3. Deliver a production-ready PDF

## Investment

| Phase | Timeline | Fee |
| --- | --- | ---: |
| Pilot | 2 weeks | $4,800 |
| Production | 4 weeks | $12,500 |`,
};

type Sample = keyof typeof samples;
type Status = "idle" | "stale" | "loading" | "ready" | "error";

export function Playground({ compact = false }: { compact?: boolean }) {
  const [activeSample, setActiveSample] = useState<Sample>("memo");
  const [markdown, setMarkdown] = useState(samples.memo);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("Ready to render");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [resultMeta, setResultMeta] = useState<{ bytes: number; units?: number } | null>(null);
  const urlRef = useRef<string | null>(null);
  const renderRevisionRef = useRef(0);

  useEffect(() => () => {
    renderRevisionRef.current += 1;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  function clearResult(nextStatus: Status = "stale") {
    renderRevisionRef.current += 1;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setDownloadUrl(null);
    setResultMeta(null);
    setStatus(nextStatus);
    setMessage(nextStatus === "stale" ? "Source changed · render again" : "Ready to render");
  }

  function chooseSample(sample: Sample) {
    setActiveSample(sample);
    setMarkdown(samples[sample]);
    clearResult("stale");
  }

  async function render() {
    const submittedMarkdown = markdown;
    clearResult("loading");
    const revision = renderRevisionRef.current;
    setMessage("Typesetting your document…");
    try {
      const result = await api.demoRender(submittedMarkdown);
      if (revision !== renderRevisionRef.current) return;
      const url = URL.createObjectURL(result.blob);
      urlRef.current = url;
      setDownloadUrl(url);
      setResultMeta({ bytes: result.blob.size, units: result.units });
      setStatus("ready");
      setMessage(`Rendered · ${formatBytes(result.blob.size)}${result.units ? ` · ${result.units} page unit${result.units === 1 ? "" : "s"}` : ""}`);
    } catch (error) {
      if (revision !== renderRevisionRef.current) return;
      const detail = error instanceof ApiError && (error.status === 502 || error.status === 503 || error.status === 0)
        ? "The renderer is unavailable right now. Your Markdown is safe—try again."
        : error instanceof ApiError ? error.message : "We could not render this document. Your Markdown is unchanged.";
      setStatus("error");
      setMessage(detail);
    }
  }

  return (
    <div className={`playground${compact ? " playground--compact" : ""}`} aria-busy={status === "loading"}>
      <div className="playground__toolbar">
        <div className="instrument-brand"><span aria-hidden="true">P/</span><strong>Render desk</strong></div>
        <span className="instrument-file">document.md</span>
        <div className="sample-switcher" aria-label="Example documents">
          {(["memo", "proposal"] as Sample[]).map((sample) => <button key={sample} type="button" aria-pressed={activeSample === sample} onClick={() => chooseSample(sample)}>{sample === "memo" ? "Brief" : "Proposal"}</button>)}
        </div>
      </div>
      <div className="playground__body">
        <div className="editor-pane">
          <label htmlFor={compact ? "dashboard-markdown" : "demo-markdown"}><span>Markdown source</span><small>Example data</small></label>
          <textarea id={compact ? "dashboard-markdown" : "demo-markdown"} value={markdown} onChange={(event) => { setMarkdown(event.target.value); setActiveSample("memo"); clearResult("stale"); }} spellCheck={false} maxLength={20_000} />
        </div>
        {!compact && (
          <div className={`paper-preview paper-preview--${status}`}>
            {downloadUrl ? (
              <article className="paper-result" aria-labelledby="preview-title"><div className="preview-label"><span>Actual render</span><small>{resultMeta ? formatBytes(resultMeta.bytes) : "PDF"}</small></div><span id="preview-title" className="sr-only">Generated PDF preview</span><iframe src={`${downloadUrl}#toolbar=0&navpanes=0`} title="Generated PDF preview" /></article>
            ) : (
              <article className="paper-preview__page" aria-labelledby="preview-title"><div className="preview-label"><span>Illustrative preview</span><small>Example data</small></div><span className="paper-preview__folio">PLUMA / 01</span><span id="preview-title" className="paper-preview__title">{activeSample === "proposal" ? "Implementation proposal" : "Weekly research brief"}</span><p className="paper-preview__lead">A production document, not a screenshot of one.</p><div className="paper-preview__lines"><i /><i /><i /><i /><i /></div><blockquote>The deliverable is part of the product.</blockquote><div className="paper-preview__footer"><span>Northstar Labs</span><span>1</span></div></article>
            )}
          </div>
        )}
      </div>
      <div className="playground__footer">
        <div className={`render-status render-status--${status}`} role="status" aria-live="polite">{status === "ready" ? <Check size={15} /> : <span className="status-dot" />}{message}</div>
        <div className="playground__actions">
          {downloadUrl && <><a className="button button--quiet" href={downloadUrl} download="pluma-document.pdf"><Download /> Download</a><Link className="button button--quiet api-key-link" href="/dashboard/keys">Create an API key</Link></>}
          <button type="button" className="button" onClick={render} disabled={status === "loading" || !markdown.trim()}>{status === "loading" ? "Rendering…" : status === "error" ? "Retry render" : "Render PDF"} {status !== "loading" && <Arrow size={16} />}</button>
        </div>
      </div>
      {!compact && <p className="playground__disclosure">Your Markdown is sent to Pluma Cloud for this render. Raw input is not kept as document history. Demo limit: 20 KiB UTF-8 and 3 output pages. <Link href="/docs/privacy">Privacy</Link></p>}
    </div>
  );
}

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}
