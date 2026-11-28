# code-editor-language

行为契约:**代码编辑器按文件名给出语法高亮 —— TypeScript 的泛型箭头函数不打断高亮;VSCode 内置能高亮的常见语言
(Python / Go / Rust / YAML / TOML / Shell / Dockerfile / SCSS / SQL / XML / Java / C / Vue …)在 Continuo 也有高亮。**

## 行为

- 语言按文件名选,对齐 VSCode 的语言模式:
  - `.ts` / `.mts` / `.cts` → TypeScript(不开 JSX:`const id = <T>(x: T): T => x;` 是泛型箭头函数,不是 JSX 标签,
    后续代码照常高亮);`.tsx` → TypeScript + JSX;`.js` / `.jsx` → JavaScript + JSX;`.mjs` / `.cjs` → JavaScript。
  - `.json` / `.jsonc` / `.json5` → JSON(lang-json 语法不含注释:`//`、`/* */` 不着色,其余照常高亮);`.css`、`.html` / `.htm`;
    `.md` / `.markdown` / `.mdx` 与 Markdown Source 模式 → Markdown + 文首 YAML frontmatter。以上同步给出。
  - JSON 家族(对齐 VSCode `extensions/json`):`.webmanifest` / `.har` / `.geojson` / `.ipynb` / `.bowerrc` / `.jscsrc` / `.jslintrc` /
    `.vuerc`,及 JSON with Comments 的 `.eslintrc` / `.babelrc` / `.jshintrc` / `.jsfmtrc` / `.swcrc` / `.hintrc` → JSON(同步);
    `composer.lock` / `.watchmanconfig` → JSON(按文件名)。`.jsonl` / `.ndjson`(JSON Lines,每行一个值)→ 用 JSON 语法着色、逐行解析
    出各个对象(多个顶层值经错误恢复,不整篇报错;编辑器无 JSON 校验),语言名 `jsonl`:不提供 JSON 格式化(VSCode 的 JSON 语言功能
    同样不含 jsonl)。
  - 日志(VSCode 内置 Log 语言,`extensions/log`):`.log` 与 `*.log.?`(轮转出的 `app.log.1`;只认一个字符的后缀,同 VSCode)→ Log,
    按需加载。规则移植自 `log.tmLanguage.json`(同位置按规则顺序、取最早开始的匹配):日期 / 时间、级别关键字
    (TRACE·verbose / DEBUG / INFO·NOTICE / WARN / ERROR·FATAL·FAIL,含 `[warn]` 形式、`error:` 形式与时间戳后的单字母级别)、
    GUID / 哈希 / 数字 / 布尔 / `0x…` / URL / 带点的名字(常量)、引号字符串、`…Exception` 类型名、`at …` 栈帧行。颜色走语义 token
    (`--md-syntax-*`,亮 / 暗 / 两套高对比度):错误红色粗体、警告黄、信息绿、调试蓝、日期 / verbose 注释色(渲染出的 ERROR / FATAL 用日志错误色,不落到通用
    invalid 色)。语言名 `log`
    (格式化等命令显示该名)。
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
| `src/panels/Editor/codemirror-log-language.ts` | Log 语言(StreamLanguage;移植 VSCode log.tmLanguage.json) |
| `src/panels/Editor/codemirror-log-tags.ts` / `code-editor-theme.ts` | 日志 tag 与语义配色 |

## Specs

| File | 覆盖 |
|---|---|
| `code-editor-language.spec.tsx` | .ts 泛型箭头函数无解析错误且后续 token 正常;各扩展名对应的 TS / JSX 配置;常见语言 / 补充文件名匹配;懒加载后高亮生效;加载中改名 / 卸载不串台 |
| `log-and-json-lines.spec.tsx` | Log 的文件匹配(`.log` / `*.log.?`)、各规则着色、加载后语言名与四套主题配色、四套主题下渲染出的 span 带对应日志高亮类;JSON 家族扩展名 / 文件名;jsonl 逐行解析且语言名 jsonl |
