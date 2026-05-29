# Prism — self-hosted webfonts

Per BRAND.md, fonts are self-hosted (no Google Fonts CDN). Drop the WOFF2 files into
this directory and the `@font-face` declarations in `src/landing/styles.css` pick
them up automatically. Until they're added, the system stack from `tokens.css`
renders cleanly — the landing page will not break.

## Required files

| File | Source | License |
|---|---|---|
| `Switzer-Medium.woff2` | [Fontshare — Switzer](https://www.fontshare.com/fonts/switzer) | OFL, free for commercial use |
| `PlusJakartaSans-Variable.woff2` | [Google Fonts — Plus Jakarta Sans](https://fonts.google.com/specimen/Plus+Jakarta+Sans) (download the static variable WOFF2) | OFL |
| `JetBrainsMono-Variable.woff2` | [JetBrains Mono GitHub](https://github.com/JetBrains/JetBrainsMono) | OFL |

## Optional upgrade (paid)

When budget allows, swap to the aspirational stack from BRAND.md:

| File | Source |
|---|---|
| `GTMaru-Medium.woff2` | [GrilliType — GT Maru](https://www.grillitype.com/typeface/gt-maru) |
| `BerkeleyMono-Regular.woff2` | [Berkeley Graphics — Berkeley Mono](https://berkeleygraphics.com/typefaces/berkeley-mono/) |

When swapping, also update the `--font-display` / `--font-mono` declarations in
`tokens.css` so the paid font appears first in the stack.

## Conversion notes

If you only have OTF/TTF, convert to WOFF2 with the
[google/woff2](https://github.com/google/woff2) tool:

```sh
woff2_compress Switzer-Medium.ttf
mv Switzer-Medium.woff2 public/fonts/
```

For Plus Jakarta Sans + JetBrains Mono variable WOFF2 files, use
[fonttools](https://fonttools.readthedocs.io/) to subset to Latin if you want
to shave bytes — they're under 100KB each subset, ~250KB full.
