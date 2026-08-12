---
title: Layout livre
subtitle: Colunas, tamanhos mistos e ilhas de Typst
author: AraraHQ
---

## Duas colunas

<!-- columns:2 -->

O texto flui de uma coluna pra outra automaticamente, com hifenização e justificação. Tudo aqui dentro continua sendo **Markdown normal** — negrito, _itálico_, listas:

- primeiro
- segundo

A quebra entre colunas é balanceada pelo motor, não na mão. Bom pra relatório, newsletter, manual técnico.

<!-- /columns -->

## Tamanhos e estilos mistos

```typst
#text(size: 18pt, weight: 700)[Uma linha grande e pesada,]
#text(size: 10pt)[ seguida de texto normal, ]
#text(size: 8pt, style: "italic", fill: rgb("#71717a"))[e um aparte pequeno em itálico cinza.]
```

O parágrafo acima é uma ilha de Typst: dentro do bloco vale qualquer coisa que o motor aceita.

```typst
#block(width: 100%, fill: rgb("#ecfeff"), radius: 6pt, inset: 12pt, stroke: 0.5pt + rgb("#0e7490"))[
  #text(weight: 700, fill: rgb("#0e7490"))[Destaque] — caixas, grids, qualquer layout. O Markdown cobre 95% do documento; a ilha cobre o resto.
]
```
