---
title: pluma
subtitle: Markdown para PDF sem browser, em milissegundos
author: AraraHQ
date: Agosto de 2026
---

## Por que existe

Gerar PDF hoje significa subir um Chrome headless: **centenas de megabytes**, segundos de cold start, dependência frágil em CI. A *pluma* compila Markdown direto para PDF usando o motor de tipografia do [Typst](https://typst.app), embutido como binding nativo — sem browser, sem LaTeX, sem binário externo.

## O que ela faz

- Títulos, **negrito**, _itálico_, ~~riscado~~ e `código inline`
- Listas ordenadas e aninhadas
  - como esta
  - e esta
- Links, imagens, citações e tabelas

> A tipografia é o que separa um documento de um arquivo de texto.

### Código

```ts
import { renderPdf } from "pluma"

const pdf = renderPdf("# Olá\nMundo.")
await Bun.write("ola.pdf", pdf)
```

### Comparação

| Abordagem | Peso | Cold start | Tipografia |
| --- | --- | --- | --- |
| Chrome headless | ~400 MB | 1–3 s | boa |
| LaTeX | ~4 GB | lento | excelente |
| **pluma (Typst)** | ~40 MB | ~50 ms | excelente |

---

Temas são objetos simples: um preamble Typst que recebe os metadados do frontmatter. Criar um tema novo é escrever meia tela de código.
