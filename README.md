# pluma

Markdown para PDF com tipografia de verdade, sem browser. A pluma converte Markdown para [Typst](https://typst.app) e compila com o motor embutido via binding nativo — nada de Chrome headless, LaTeX ou binário externo. Um documento típico compila em dezenas de milissegundos.

```bash
npm install @ararahq/pluma
```

## 30 segundos

```bash
pluma documento.md
```

Pronto: `documento.pdf` com tipografia justificada, tabelas com régua, código com highlight e numeração de página. Sem configurar nada.

## Com a sua identidade

Crie um `brand.json` ao lado dos seus documentos:

```json
{
  "fonts": { "body": "Geist", "mono": "Geist Mono" },
  "colors": { "accent": "#0e7490", "link": "#0e7490" },
  "logo": { "path": "assets/logo.png", "width": "3.2cm" },
  "footer": "Minha Empresa — exemplo.com"
}
```

```bash
pluma proposta.md
```

Sem flag nenhuma: um `brand.json` ao lado do `.md` é usado automaticamente, e um diretório `fonts/` ao lado entra sozinho como fonte de fontes (`.ttf`/`.otf`). O logo entra no topo, o accent colore a régua do título, o footer aparece em toda página e o corpo inteiro usa a sua fonte. Caminhos de logo e imagens resolvem relativos ao documento.

O documento também pode declarar a própria identidade no frontmatter (`brand: ./caminho.json`), e as flags `--brand`/`--fonts` sobrepõem tudo quando você precisar. Precedência: flag > frontmatter > convenção.

Iterando no visual:

```bash
pluma proposta.md --watch
```

Recompila a cada salvamento (~50 ms) — deixe o PDF aberto do lado e escreva.

Todos os tokens são opcionais — o que você não definir cai no padrão:

| Token | O que controla |
| --- | --- |
| `fonts.body` / `fonts.heading` / `fonts.mono` | fontes do corpo, títulos e código |
| `fonts.size` | tamanho base em pt (padrão 10.5) |
| `colors.text` / `muted` / `faint` | texto, secundário, terciário |
| `colors.accent` | régua do título |
| `colors.link` / `border` / `codeBackground` | links, bordas, fundo de código |
| `page.paper` / `marginX` / `marginY` | papel (a4, us-letter...) e margens |
| `logo.path` / `logo.width` | logo do cabeçalho |
| `footer` | texto do rodapé (nº de página é automático) |

## Metadados do documento

Frontmatter vira o cabeçalho:

```markdown
---
title: Proposta comercial
subtitle: Escopo e investimento
author: Ana Silva
date: Agosto de 2026
---
```

## Diretivas no documento

Controle pontual entra como comentário HTML — invisível em qualquer renderizador de Markdown:

```markdown
Fim da seção.

<!-- pagebreak -->

## Próxima seção em página nova

<!-- columns:2 -->
Este trecho flui em duas colunas balanceadas.
<!-- /columns -->
```

## Ilhas de Typst (layout livre)

Quando precisar do que o Markdown não expressa — tamanhos mistos na mesma linha, caixas, grids — abra um bloco `typst`. O conteúdo passa direto pro motor:

````markdown
```typst
#text(size: 18pt, weight: 700)[Grande,]
#text(size: 8pt, style: "italic")[ e pequeno em itálico.]

#block(fill: rgb("#ecfeff"), radius: 6pt, inset: 12pt)[Uma caixa de destaque.]
```
````

Markdown cobre 95% do documento; a ilha cobre o resto com o poder total do [Typst](https://typst.app/docs). Nota: blocos `typst` executam código de layout — use apenas com documentos de autores confiáveis.

## Como biblioteca

```ts
import { renderPdf } from "@ararahq/pluma"
import { writeFileSync } from "node:fs"

const pdf = renderPdf(markdown, {
  brand: {
    fonts: { body: "Geist" },
    colors: { accent: "#0e7490" },
    logo: { path: "logo.png" },
    footer: "Minha Empresa",
  },
  fontPaths: ["./fonts"],
  root: "./docs",
})

writeFileSync("saida.pdf", pdf)
```

`root` define de onde resolver logo e imagens. `markdownToTypstSource(md, opts)` devolve o fonte Typst gerado (o CLI expõe como `--typst`) — útil pra depurar ou levar pro app do Typst.

## Controle total (escape hatch)

Quando os tokens não bastam, um tema é só um objeto com um preamble Typst:

```ts
import { renderPdf, type Theme } from "@ararahq/pluma"

const meuTema: Theme = {
  name: "meu-tema",
  preamble: (meta) => `
#set page(paper: "a5", margin: 1.5cm)
#set text(font: "Inter", size: 9pt)
`,
}

renderPdf(markdown, { theme: meuTema })
```

## CLI

```
pluma <entrada.md> [opções]

-o, --output <arquivo>   caminho do PDF (padrão: <entrada>.pdf)
-t, --theme <nome>       tema embutido
-b, --brand <arquivo>    identidade em JSON
-f, --fonts <dir>        diretório de fontes (repetível)
    --typst              emite o fonte Typst em vez de compilar
```

## AI-first

A pluma foi desenhada pra ser usada tanto pelo seu código quanto por um agente de IA:

- **MCP embutido**: `pluma mcp` sobe um servidor MCP por stdio com a tool `render_pdf(markdown, output_path, brand?, fonts_dir?, root?)`. Registre no Claude Code / Cursor / qualquer cliente MCP com `command: "pluma", args: ["mcp"]` e o agente gera PDFs com a sua marca sozinho. Zero dependência extra.
- **`--json`**: `pluma doc.md --json` responde `{"ok":true,"output":"doc.pdf"}` (ou `{"ok":false,"error":{...}}`) no stdout — parseável por script ou agente.
- **Entrada tolerante**: documento embrulhado em ```` ```markdown ```` (mania de LLM) é desembrulhado automaticamente.
- **[llms.txt](llms.txt)**: a lib inteira documentada numa página pra modelos — dialeto suportado, diretivas, shape do brand, API. Vai junto no pacote npm.
- **[Schema JSON do brand](schema/brand.schema.json)**: valida o `brand.json` no editor e dá autocomplete pra humanos e IAs.

## Suporte de Markdown

Títulos, parágrafos, negrito/itálico/riscado, código inline e em bloco (com highlight), links, imagens, citações, listas ordenadas e aninhadas, tabelas GFM com alinhamento e réguas horizontais. HTML cru é ignorado. Texto do usuário é escapado — Markdown não injeta código Typst.

## Por que não Chrome

| | Peso | Cold start |
| --- | --- | --- |
| Chrome headless | ~400 MB | 1–3 s |
| pluma | ~40 MB | ~50 ms |

## Licença

MIT
