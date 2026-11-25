# code-editor-language

行为契约:**代码编辑器按文件名给出语法高亮 —— TypeScript 的泛型箭头函数不打断高亮;VSCode 内置能高亮的常见语言
(Python / Go / Rust / YAML / TOML / Shell / Dockerfile / SCSS / SQL / XML / Java / C / Vue …)在 Continuo 也有高亮。**

## 行为

- 语言按文件名选,对齐 VSCode 的语言模式:
  - `.ts` / `.mts` / `.cts` → TypeScript(不开 JSX:`const id = <T>(x: T): T => x;` 是泛型箭头函数,不是 JSX 标签,
    后续代码照常高亮);`.tsx` → TypeScript + JSX;`.js` / `.jsx` → JavaScript + JSX;`.mjs` / `.cjs` → JavaScript。
  - `.json` / `.jsonc` / `.json5` → JSON(lang-json 语法不含注释:`//`、`/* */` 不着色,其余照常高亮);`.css`、`.html` / `.htm`;
    `.md` / `.markdown` / `.mdx` 与 Markdown Source 模式 → Markdown + 文首 YAML frontmatter。以上同步给出。
  - 其余按 `@codemirror/language-data` 的语言表(与 Markdown 编辑模式代码块同源)按扩展名 / 文件名匹配,另补该表认不出的常见文件:
    `Dockerfile.*` / `*.dockerfile` / `Containerfile` → Dockerfile;`.env` / `.env.*` → Properties;
    `.bashrc` / `.zshrc` / `.profile` / `*.zsh` 等 → Shell;`Makefile` / `GNUmakefile` / `*.mk` → Shell(语言表无 Makefile 语法,
    recipe 行本就是 shell,取最接近的)。扩展名大小写不敏感(`.PY` 同 `.py`)。认不出的文件 → 纯文本。
- 语言表里的语言包按需懒加载(独立 chunk,首屏不变大):加载完成前先按纯文本显示,完成后原地换上高亮,不重建编辑器、
  不动光标 / 撤销历史;同一语言加载过一次后再打开即同步高亮。
- 防竞态:加载期间文件改名 / 换文件 / 编辑器卸载 → 旧文件的加载结果不套用到新文件(不报错)。语言包加载失败 → 保持纯文本。

## Modules

| File | Role |
|---|---|
| `src/panels/Editor/CodeEditor.tsx` | `pickLanguage`(同步可得的语言)、`languageDescriptionFor`(语言表匹配 + 补充文件名)、懒加载后 reconfigure 语言 Compartment |

## Specs

| File | 覆盖 |
|---|---|
| `code-editor-language.spec.tsx` | .ts 泛型箭头函数无解析错误且后续 token 正常;各扩展名对应的 TS / JSX 配置;常见语言 / 补充文件名匹配;懒加载后高亮生效;加载中改名 / 卸载不串台 |
