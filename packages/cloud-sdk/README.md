# @ararahq/pluma-cloud

Typed server-side client for turning Markdown into branded, production-ready PDFs with Pluma Cloud.

```bash
npm install @ararahq/pluma-cloud
```

```ts
import { Pluma } from "@ararahq/pluma-cloud"

const pluma = new Pluma({ apiKey: process.env.PLUMA_API_KEY! })
const source = await pluma.read({ url: "https://example.com/report" })
const answer = await myAgent.run(source.markdown)
const { pdf } = await pluma.render({ markdown: answer })
```

The client adds an idempotency key to every document request, preserves Pluma
request IDs and metering metadata, and exposes structured `PlumaError` failures.
Keep API keys in server-side code only.
