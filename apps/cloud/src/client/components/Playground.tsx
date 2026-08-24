import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { Arrow, Check, Download } from "./Icons";

const samples = {
  memo: `---
title: "Weekly research brief"
author: "Northstar Research"
---

# A calmer way to ship agent output

AI agents are good at producing Markdown. Pluma turns that output into a document people can review, forward, and trust.

## This week

- **18 sources** reviewed across product and market research
- **3 decisions** ready for approval
- **1 risk** needs an owner before Friday

> The deliverable is part of the product—not an afterthought.

## Recommendation

Keep the pipeline in Markdown. Render the final artifact at the boundary.`,
  proposal: `---
title: "Implementation proposal"
author: "Fieldwork Studio"
---

# Document automation, without a browser

Prepared for **Acme Systems** · August 2026

## Scope

1. Generate the proposal in Markdown
2. Apply the client brand automatically
3. Deliver a production-ready PDF

## Investment

| Phase | Timeline | Fee |
| --- | --- | ---: |
| Pilot | 2 weeks | $4,800 |
| Production | 4 weeks | $12,500 |

Payment terms: 50% at kickoff, 50% on delivery.`,
};

export function Playground({ compact = false }: { compact?: boolean }) {
  const [markdown, setMarkdown] = useState(samples.memo);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [message, setMessage] = useState("Ready to render");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  async function render() {
    setStatus("loading");
    setMessage("Typesetting your document…");
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    setDownloadUrl(null);
    try {
      const result = await api.demoRender(markdown);
      const url = URL.createObjectURL(result.blob);
      urlRef.current = url;
      setDownloadUrl(url);
      setStatus("ready");
      setMessage(result.units ? `Rendered · ${result.units} page unit${result.units === 1 ? "" : "s"}` : "Your PDF is ready");
    } catch (error) {
      const detail = error instanceof ApiError && (error.status === 502 || error.status === 503 || error.status === 0)
        ? "The demo renderer is unavailable right now. Try again shortly."
        : error instanceof ApiError ? error.message : "We could not render this document.";
      setStatus("error");
      setMessage(detail);
    }
  }

  return (
    <div className={`playground${compact ? " playground--compact" : ""}`}>
      <div className="playground__toolbar">
        <div className="window-dots" aria-hidden="true"><i /><i /><i /></div>
        <span>document.md</span>
        <div className="sample-switcher" aria-label="Document samples">
          <button type="button" onClick={() => setMarkdown(samples.memo)}>Memo</button>
          <button type="button" onClick={() => setMarkdown(samples.proposal)}>Proposal</button>
        </div>
      </div>
      <div className="playground__body">
        <div className="editor-pane">
          <label htmlFor={compact ? "dashboard-markdown" : "demo-markdown"}>Markdown</label>
          <textarea
            id={compact ? "dashboard-markdown" : "demo-markdown"}
            value={markdown}
            onChange={(event) => setMarkdown(event.target.value)}
            spellCheck={false}
            maxLength={20_000}
          />
        </div>
        {!compact && (
          <div className="paper-preview" aria-label="Document preview">
            <div className="paper-preview__page">
              <span className="paper-preview__folio">PLUMA / 01</span>
              <h3>{markdown.includes("Implementation proposal") ? "Implementation proposal" : "Weekly research brief"}</h3>
              <p className="paper-preview__lead">A production document, not a screenshot of one.</p>
              <div className="paper-preview__lines"><i /><i /><i /><i /><i /></div>
              <blockquote>The deliverable is part of the product.</blockquote>
              <div className="paper-preview__footer"><span>Northstar Research</span><span>1</span></div>
            </div>
          </div>
        )}
      </div>
      <div className="playground__footer">
        <div className={`render-status render-status--${status}`} role="status" aria-live="polite">
          {status === "ready" ? <Check size={15} /> : <span className="status-dot" />}{message}
        </div>
        <div className="playground__actions">
          {downloadUrl && <a className="button button--quiet" href={downloadUrl} download="pluma-document.pdf"><Download /> Download</a>}
          <button type="button" className="button" onClick={render} disabled={status === "loading" || !markdown.trim()}>
            {status === "loading" ? "Rendering…" : "Render PDF"} {status !== "loading" && <Arrow size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}
