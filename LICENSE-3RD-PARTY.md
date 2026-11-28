# Third-party notices

Continuo is MIT-licensed (see [LICENSE](LICENSE)). npm dependencies keep their own licenses inside `node_modules`. The components below are copied into this repository or bundled into the packaged app outside of npm, so their notices are collected here.

## Aceternity UI · MIT License

Source copied and adapted (not installed from npm):

- **Spotlight** — `src/shell/decor/Spotlight.tsx`
  - Source: <https://ui.aceternity.com/components/spotlight>
  - Author: Manu Arora
  - Changes: `cn(@/lib/utils)` replaced with `clsx`; keyframes moved to `src/styles/decor.css`; switched to a named export.

- **Background Beams** — `src/shell/decor/BackgroundBeams.tsx`
  - Source: <https://ui.aceternity.com/components/background-beams>
  - Author: Manu Arora
  - Changes: `cn(@/lib/utils)` replaced with `clsx`; removed the unused static outline layer; `useMemo` pins the random transitions to cut re-renders; removed `"use client"`; the gradients stay static under reduced motion.

## MesloLGS Nerd Font Mono

- File: `src/assets/fonts/MesloLGSNerdFontMono-Regular.woff2` (terminal font, bundled into the app), from [Nerd Fonts](https://github.com/ryanoasis/nerd-fonts) `patched-fonts/Meslo/S`.
- Meslo LG: Copyright 2009, 2010, 2013 André Berg — Apache License 2.0. Full text: [`licenses/MesloLGS-NF-LICENSE.txt`](licenses/MesloLGS-NF-LICENSE.txt).
- Nerd Fonts patching: Copyright (c) 2014 Ryan L McIntyre — MIT (patcher) / SIL OFL 1.1 (patched fonts). Full text: [`licenses/nerd-fonts-LICENSE.md`](licenses/nerd-fonts-LICENSE.md).
- Icon glyphs added by Nerd Fonts keep their own licenses:

| Icon set | Upstream | License |
|---|---|---|
| Codicons | <https://github.com/microsoft/vscode-codicons> | CC BY 4.0 |
| Devicons | <https://github.com/devicons/devicon> | MIT |
| extraglyphs | <https://github.com/source-foundry/Hack> | MIT |
| Font Awesome | <https://github.com/FortAwesome/Font-Awesome> | CC BY 4.0 |
| Font Awesome Extension | <https://github.com/AndreLZGava/font-awesome-extension> | MIT |
| Font Logos | <https://github.com/lukas-w/font-logos> | Unlicense |
| Material Design Icons | <https://github.com/Templarian/MaterialDesign-Font> | Apache 2.0 |
| Octicons | <https://github.com/primer/octicons> | MIT |
| Seti UI | <https://github.com/jesseweed/seti-ui> | MIT |
| Pomicons | <https://github.com/gabrielelana/pomicons> | SIL OFL 1.1 |
| Powerline Extra Symbols | <https://github.com/ryanoasis/powerline-extra-symbols> | MIT |
| Powerline Symbols | <https://github.com/powerline/powerline> | MIT |
| Power Symbols IEC | <https://github.com/jloughry/Unicode> | MIT |
| Weather Icons | <https://github.com/erikflowers/weather-icons> | SIL OFL 1.1 |

## Visual Studio Code (microsoft/vscode) · MIT License

Code and data ported or copied from <https://github.com/microsoft/vscode> (© Microsoft Corporation). Code that only follows VS Code's behavior or design is not listed. Full license text: [MIT License text (Visual Studio Code)](#mit-license-text-visual-studio-code).

- `src/panels/Editor/unicode-ambiguous-data.ts` — confusable-character data from `src/vs/base/common/strings.ts` (`AmbiguousCharacters.ambiguousCharacterData`); subset for the UI languages.
- `src/lib/fuzzy-scorer.ts` — ported from `src/vs/base/common/fuzzyScorer.ts`, with `matchesPrefix` (`filters.ts`) and `compareAnything` / `compareByPrefix` (`comparers.ts`).
- `src/panels/Editor/indentation-guesser.ts` — ported from `src/vs/editor/common/model/indentationGuesser.ts`.
- `electron/shared/workspace-search.ts` — `lcut` ported from `src/vs/base/common/strings.ts`.
- `electron/main/menu-mnemonic.ts` — `mnemonicMenuLabel` ported from `src/vs/base/common/labels.ts`.
- `src/plugins/quick-open/goto-line.ts` — `FILE_LINE_PATTERN` copied from `LINE_COLON_PATTERN` (`extractRangeFromFilter`, `src/vs/workbench/contrib/search/common/search.ts`).
- `electron/shared/host-color-scheme.ts` — `hostColorSchemeFromNativeTheme` ported from `getColorScheme` in `src/vs/platform/theme/electron-main/themeMainServiceImpl.ts`.
- `electron/shared/text-encoding.ts` — encoding ids, labels and order from `SUPPORTED_ENCODINGS` (`src/vs/workbench/services/textfile/common/encoding.ts`); subset.
- `src/panels/Terminal/useTerminal.ts` — high-contrast terminal palettes from the `hcDark` / `hcLight` defaults in `src/vs/workbench/contrib/terminal/common/terminalColorRegistry.ts`.
- `src/styles/theme.css` — high-contrast (`.hc-black` / `.hc-light`) values of Continuo's own slots: syntax colors from `extensions/theme-defaults/themes/hc_black.json` / `hc_light.json`, and the `hcDark` / `hcLight` defaults of `contrastBorder` / `contrastActiveBorder`, debug breakpoint / stack-frame colors, `list.highlightForeground`, `textLink.foreground` and `gitDecoration.*` (some lightened / darkened for contrast).
- `src/styles/design-tokens.css` — the `.hc-black` / `.hc-light` palettes from the `hcDark` / `hcLight` defaults in `src/vs/platform/theme/common/colors/*.ts` (color registry; some lightened / darkened for contrast).
- `src/panels/Editor/copy-html.ts` — copy-with-syntax-highlighting HTML: `tokenizeLineToHTML` ported from `src/vs/editor/common/languages/textToHtmlTokenizer.ts`, outer wrapper from `getRichTextToCopy` (`src/vs/editor/common/viewModel/viewModelImpl.ts`).

## CodeMirror (codemirror/search) · MIT License

Code copied from <https://github.com/codemirror/search> (`@codemirror/search`, © Marijn Haverbeke and others) where the package does not export it. Full license text: [MIT License text (CodeMirror)](#mit-license-text-codemirror).

- `src/panels/Editor/codemirror-find.ts` — `announceMatch` and the replacement-string handling (`unquote` + regexp `getReplacement`) copied from `src/search.ts`; `lastMatchIn` ported from `RegExpQuery.prevMatchInRange` in the same file.

## vscode-js-debug · MIT License

- Downloaded at build time by `scripts/fetch-debug-adapter.mjs` (pinned version, SHA-256 verified) and bundled into packaged apps as `js-debug/`, which ships with its own `LICENSE`.
- © Microsoft Corporation — <https://github.com/microsoft/vscode-js-debug>

## MIT License text (Aceternity UI)

```
MIT License

Copyright (c) Aceternity / Manu Arora

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## MIT License text (Visual Studio Code)

```
MIT License

Copyright (c) 2015 - present Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## MIT License text (CodeMirror)

```
MIT License

Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
