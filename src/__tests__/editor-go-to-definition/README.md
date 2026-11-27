# TS / JS 转到定义(F12 / ⌘ 单击 / ⌘ 悬停),接真实 TypeScript 语言服务

VSCode 迁移用户在 TS / JS 文件里按 F12、⌘ 单击标识符,期望跳到定义;此前 Continuo 没有语言服务,只提示「未找到定义」。
本主题对齐 VSCode 内置 `typescript-language-features` 的转到定义:语言服务进程跑**内置** typescript 的 LanguageService
(不做 `typescript.tsdk` 版本选择),编辑器里未保存的内容同步给它。

## 适用范围

- 语言:`.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs`(含 `.d.ts`)、有磁盘路径的文件,且位于窗口打开的文件夹之内。
- 其它文件(Markdown 源码模式、JSON、无标题文件…)、Markdown 代码块:行为不变 —— F12 仍是「未找到 'x' 的定义」提示,⌘ 单击
  照旧(Markdown 源码模式 ⌘ 单击打开链接、终端 ⌘ 单击打开链接都不受影响)。

## 行为

1. **F12 / 右键「转到定义」/ 命令面板 `editor.action.revealDefinition`**:按光标处请求定义。
   - 一个结果:跳转。同文件 → 光标移到定义名开头并居中;别的文件 → 在当前编辑器组打开(走 `openFileInEditor` / `openFileByPath`,
     已打开则切换)并定位。跳转前记下来处,**⌃-(后退)回到跳转前的位置**。
   - 多个结果(如声明合并的 interface):选择器列出每个定义(该行预览 + `文件名:行` + 相对目录),可过滤,Enter / 单击跳到所选。
     VSCode 默认 `editor.gotoLocation.multipleDefinitions: peek`(内联 peek 视图);本项目没有 peek,以选择器代替,不提供该设置。
   - 没有结果 / 不在标识符上 / 服务不可用:VSCode 文案「未找到 'x' 的定义」(不在单词上「未找到定义」)。
   - 右键菜单(TS / JS 文件):顶部「转到定义 F12」+ 分隔线(VSCode 编辑器右键菜单同);右键处不在选区内时光标先移到右键处。
2. **⌘ 单击(mac)/ Ctrl 单击(Windows / Linux)**:按下照常放置光标,松开且没拖动 → 按该处请求;有定义则同 1 跳转,没有则静默
   (VSCode `muteMessage`)。不在单词上不做事、不加光标;⌥ 单击加光标不变。
3. **按住 ⌘ / Ctrl 悬停**:鼠标所在单词有定义 → 该标识符(语言服务给的区间)加下划线 + 手型指针;松开修饰键、移开、失焦、编辑
   → 消失。悬停请求与命令请求各占一槽,同槽新请求取消旧请求,迟到的结果丢弃。
4. **定义解析**(TypeScript LanguageService `getDefinitionAndBoundSpan`):同文件、跨文件 import、import 路径字符串(→ 目标文件开头)、
   默认导出、重导出(barrel → 原始声明)、类成员方法、node_modules 包的 `.d.ts`、内置 `lib.*.d.ts`。
5. **未保存内容**:编辑器里所有未保存的 TS / JS 标签随每个请求同步(按版本去重;服务重启 / 换工作区后自动补全文),定位按未保存的
   内容算(本文件与别的文件的修改都生效)。已保存的文件服务自己按磁盘内容读(mtime 变化即重读),不需要文件监听。
6. **项目**:文件就近的 `tsconfig.json` / `jsconfig.json`;该配置不含此文件 → 依次看其 project references、上一级配置;都没有 →
   推断项目(VSCode inferred project 默认选项:`module: preserve`、`moduleResolution: bundler`、`target: ES2022`、`jsx: react-jsx`、
   `allowJs`、`strict` …)。
7. **服务进程生命周期**:Electron `utilityProcess`,每个主窗一个(popout 子窗共用其主窗的),堆上限 3072 MB(VSCode
   `typescript.tsserver.maxTsServerMemory` 默认值)。打开第一个 TS / JS 文件时启动并预热(加载其项目);关窗 / 重载 → 结束;换工作区 →
   下个请求按新根重启。**崩溃** → 提示「JS/TS 语言服务已崩溃。」,下个请求自动重启并恢复未保存内容;5 分钟内崩溃 5 次 → 提示后
   不再重启(重载窗口 / 换文件夹后恢复)。单个请求 30 秒超时。
8. **安全**:服务进程只读工作区、工作区及其祖先目录的 `node_modules`、内置 typescript 的 lib 目录,其余路径一律当作不存在;
   不执行项目代码 —— `compilerOptions.plugins` 不加载(用 `ts.createLanguageService`,不存在插件加载路径;VSCode 对不受信任的
   工作区同样不加载),不做自动类型获取。IPC 走 safe-handle 管线(frame 信任 + zod 限幅),根取自发送窗口的工作区。

## 规范文件

- `go-to-definition.spec.ts`:1–5、7 的端到端行为 —— CodeMirror 视图 + 编辑器 store + 导航历史 + renderer 客户端 + main 的
  ts-language.service + 进程内消息循环 + 真实 TypeScript,在临时工程上跑(进程本身用同进程替身,崩溃由替身模拟)。
- 模块级 TDD:`electron/main/__tests__/ts-language-core.test.ts`(项目选择 / overlay / 只读范围 / 插件不加载)、
  `electron/main/__tests__/ts-language-service.test.ts`(懒启动 / 版本同步 / 取消 / 超时 / 崩溃上限 / 生命周期 / 消息循环)。
- 右键菜单项:`src/__tests__/edit-context-menu/`。

## 扩展点(本次未做)

⇧F12 引用、⌥F12 peek、F2 重命名、悬停提示、⇧⌘O 文件符号:在 `ts-server-protocol` 加请求类型、`ts-language-core` 调对应的
LanguageService 方法(`getReferencesAtPosition` / `getQuickInfoAtPosition` / `getNavigationTree` / `findRenameLocations`),
renderer 侧复用 `requestTsLanguage`(文档同步、槽位取消)与 `showLocations` / `goToLocation`(多位置选择器、带导航记录的跳转)。
