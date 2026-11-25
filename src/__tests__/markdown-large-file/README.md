# 较大 Markdown 以源码模式打开

修复前:240 KB / 1.8 万行的 Markdown 用编辑 / 预览模式打开或切换时界面冻结 3–4.6 s 无任何提示(Milkdown / ProseMirror 解析与
建视图是一个同步长任务;编辑模式逐键 80–140 ms),源码模式(CodeMirror)只要 0.77 s。

## 参考

- VSCode 大文件:超过阈值(`editor.largeFileOptimizations`)时关闭折叠、高亮等高开销功能,并在编辑器顶部给一行提示说明原因;
  用户仍可手动打开这些功能。
- 本仓库已有的同类降级:含 frontmatter / wiki-link 的「不安全」Markdown 请求编辑模式时实际落到源码模式,顶部一行提示
  (`panels.editor.milkdownUnsafe.banner`),窗口级模式不被改写(`src/__tests__/editor-milkdown-roundtrip-safety/`)。

## 行为

1. **阈值**:Markdown 内容超过 `MILKDOWN_LARGE_DOC_CHARS`(10 万个字符,UTF-16 code unit)即为「较大」。依据:实测渲染耗时
   约与长度成正比(240 KB ≈ 3.5 s),10 万字符约 1.5 s 内;常见 README / 设计文档远小于此,不受影响。判定在打开 / 外部重新
   读盘 / 改名时做,编辑过程中不重算(避免输入跨过阈值时编辑器突然换引擎)。
2. **降级**:窗口级模式为编辑 / 预览时,较大的 Markdown 实际按**源码**模式显示(`getEffectiveMode` → `source`,
   `usesMilkdownEngine` → false),模式切换器显示「源码」;窗口级模式(`mode`)不被改写 —— 其它 Markdown 仍按编辑 / 预览打开,
   会话持久化的模式也不变。
3. **提示**:降级时编辑区顶部一行非打扰提示「文件较大,已以源码模式打开…」(三语),不弹窗、不抢焦点。窗口级模式本就是源码时
   不提示(没有降级)。
4. **手动切换**:在切换器选编辑 / 预览 → 该 tab 记为「已接受」(runtime,按 tab,关闭即失效),之后按所选模式渲染(慢是用户
   的选择)。切换前先把提示换成「正在渲染…」并让它画出来,再开始渲染(渲染期间主线程阻塞,提示保持可见),Milkdown 就绪后
   消失。同时是不安全 Markdown 时先走「仍然切换」确认。
5. 其它较大 tab 不受某个 tab「已接受」影响。

## 可执行规范

- `markdown-large-file.spec.tsx`
