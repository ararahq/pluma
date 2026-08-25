# Pluma brand system

Pluma uses **Typesetting Gate** as its product symbol. Three uneven source lines
approach a controlled typesetting boundary and leave as one stable document
line. The mark describes the product action; it is not a page, feather, quill,
sparkle, or AI glyph.

## Canonical assets

- `source/pluma-symbol-master.svg`: approved 160 × 160 construction.
- `source/pluma-symbol-small.svg`: pixel-hinted 16 × 16 master for 16-32 px.
- `source/pluma-wordmark.svg`: Geist Bold converted to vector outlines.
- `source/ararahq/`: immutable official parent artwork.
- `dist/`: production-ready color, reverse, mono, horizontal, endorsed, and
  favicon assets.

The Pluma wordmark is vector artwork. Interfaces still expose the accessible
name `Pluma`; do not replace accessible text with an unlabeled image.

## Geometry

The symbol uses a 160 × 160 artboard. Live artwork is centered inside
`x=21..139`, `y=31..129`.

- input bars: 11 units high at y 41, 75, and 109;
- input lengths: 43, 52, and 43 units from x 21;
- gate vertices: `(65,31) (83,31) (101,55) (101,105) (83,129)
  (65,129) (85,100) (85,60)`;
- output bar: 11 units high from x 96 to 139 at y 75;
- horizontal terminals are square; the master has no stroke, radius, shadow,
  highlight, or gradient.

For UI crops at 48 px and above, `viewBox="13 13 134 134"` may be used without
changing the paths. At 16-32 px use the small-size master so the rails remain
two physical pixels at 16 px.

## Color

| Role | Light | Dark |
| --- | --- | --- |
| Rails / wordmark | Midnight `#111936` | Cold white `#F7F9FF` |
| Typesetting gate | Cobalt `#3D5AFE` | Light cobalt `#5B75FF` |
| Parent mark | Official artwork only | Official artwork only |

Red, orange, yellow, and green are reserved for semantic error, warning,
pending, and success states. They are not brand accents.

## Clearspace and minimum size

- clearspace around the symbol: at least 40 units (`0.25M`);
- symbol-to-wordmark gap: 61 units (`0.38125M`);
- complete horizontal lockup: 120 px wide minimum;
- standalone symbol: 16 px using the small master, 48 px using the full master;
- full endorsed lockup: 230 px wide recommended, 210 px absolute minimum;
- official AraraHQ lockup inside the endorsement: never below 88 px wide.

## Brand architecture

Use Pluma alone in task-focused contexts: favicon, npm, GitHub, CLI, MCP,
skills, dashboard, site header, and render states.

Use the endorsed lockup on marketing footers, About/company surfaces, launch
media, invoices, legal/press material, and partnerships. The endorsement is:

```text
[Typesetting Gate]  Pluma
                    by  [official horizontal AraraHQ artwork]
```

Never retype, redraw, recolor, skew, or merge the AraraHQ artwork into the
Typesetting Gate. The parent teal is not a Pluma action color. The complete
endorsement is not inserted into customer PDFs by default.

## AraraHQ artwork provenance

The copied parent masters are exact, unmodified files from the AraraHQ
dashboard repository at commit `86890fc58ce9a2457244af509159390464708dc3`.

| Asset | Source path | SHA-256 |
| --- | --- | --- |
| Light surface | `public/brand/logo-horizontal-light.svg` | `980e46af269249e9cea15d909b8e432e2a43992952fa2cdd340d5d2428d6d468` |
| Dark surface | `public/brand/logo-horizontal-dark.svg` | `6380e651a56e19cd862c12573ccb8e9d4baca2238bf3ca42d8f31f59f0bedd0f` |

## Wordmark provenance

The vector wordmark is outlined from `examples/fonts/Geist-Bold.ttf`, SHA-256
`e866b423b755233cae8bce6a37519f6fe630be9772fa08fc3114bff15bc8580f`.
The bundled license is preserved at `source/LICENSE-Geist.txt`.

## Misuse

Do not:

- substitute a typed `P`, page icon, feather, or sparkle;
- round the rails or add glow, gradient, or drop shadow to the master;
- place the full endorsed lockup in the header or favicon;
- recolor the AraraHQ artwork cobalt;
- set `by AraraHQ` as plain interface text where the visual endorsement is
  expected;
- compress either logo by setting width and height independently.
