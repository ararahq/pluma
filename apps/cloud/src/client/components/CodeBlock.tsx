import { useState } from "react";
import { Check, Copy } from "./Icons";

export function CodeBlock({ code, language = "ts", title }: { code: string; language?: string; title?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="code-block">
      <div className="code-block__bar">
        <span>{title || language}</span>
        <button type="button" className="icon-button" onClick={copy} aria-label="Copy code">
          {copied ? <Check /> : <Copy />}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}
