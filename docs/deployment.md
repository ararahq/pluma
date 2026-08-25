# Running Pluma locally

Pluma's open-source engine does not require a hosted service, browser process,
database, or account. Install the package and render or inspect files inside
your own process.

## CLI

```bash
npm install --global @ararahq/pluma
pluma document.md --output document.pdf
```

For reproducible applications, pin the package version in `package-lock.json`
instead of relying on a global installation.

## Node API

```ts
import { renderPdf } from "@ararahq/pluma";
import { writeFile } from "node:fs/promises";

const pdf = await renderPdf("# Release notes");
await writeFile("release-notes.pdf", pdf);
```

## MCP

Run the stdio server from the project directory whose files it may access:

```bash
pluma mcp
```

Safe mode restricts file access to the working directory and enforces input,
output, page, and token limits. Keep the working directory narrow when an agent
controls the process.

## Pluma Context

Compile CSV, XLSX, or Parquet into an integrity-checked `.pluma` package:

```bash
pluma context compile transactions.parquet --output transactions.pluma
pluma context inspect transactions.pluma
```

The package and source stay on your machine. Use the query/export CLI or the
Node API to produce bounded context and CSV, XLSX, or Parquet outputs.

The hosted Pluma Cloud service is a separate commercial product. Its source,
infrastructure, credentials, and operational runbooks are intentionally not
part of this MIT repository.
