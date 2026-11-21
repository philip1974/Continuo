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
