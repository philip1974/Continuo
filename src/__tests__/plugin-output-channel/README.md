# plugin-output-channel — 插件输出通道(`app.output`)与「输出」面板

用户选定的功能:插件作者看插件日志 / 失败原因不必开 DevTools。

## 对齐 VSCode

- `window.createOutputChannel(name)` → `OutputChannel`(`src/vs/workbench/api/common/extHostOutput.ts`:`append` /
  `appendLine`(= append(value + '\n'))/ `clear` / `replace` / `show` / `hide` / `dispose`;`LogOutputChannel` 每行带
  `<时间> [level]` 前缀)。Continuo 取最小必要子集:`name` / `append` / `appendLine` / `clear` / `show`,外加
  `createOutputChannel(name)`(带 `dispose`)。
- 输出视图(`src/vs/workbench/contrib/output/browser/outputView.ts`、`output.contribution.ts`):标题栏下拉切换通道、
  「Clear Output」、「Turn Auto Scrolling Off/On」锁;`output.smartScroll`:内容变化时未锁定就滚到最后一行,用户把光标 /
  视图移离最后一行即锁定、回到最后一行即解锁。
- 扩展的 `console.*`:扩展宿主经 `extHostConsoleForwarder.ts` 转发到窗口的开发者工具控制台,**不**进扩展自己的输出通道。
  Continuo 插件本就跑在 renderer,console 直达 DevTools → 不镜像(保持简单)。

## 刻意差异

- 每个插件**自动**有一个以插件名命名的默认通道(`app.output` 本身就是它;VSCode 要扩展自己创建),宿主把该插件的激活失败、
  加载跳过原因、未捕获错误写进去(VSCode 记进 Extension Host 日志通道)。默认通道首次写入时出现在下拉里。
- 不提供 `replace` / `hide` / LogOutputChannel 的分级方法;通道不持久化(随窗口重载清空,同 VSCode 输出模型)。

## 行为契约(`plugin-output-channel.spec.tsx`、`sdk-contract/shape/runtime-existence.spec.ts`)

- 通道内容按行追加:`append` 不换行、`appendLine` 换行,`\r\n` 归一;每通道环形缓冲(≤ 10,000 行、≤ 2,000,000 字符,
  超出丢最早的行),单行 ≤ 10,000 字符、单次 append ≤ 1,000,000 字符(截断)。
- `app.output`:默认通道 id `plugin:<id>`、名 = manifest.name;值不是字符串 → `BAD_INPUT`;`show()` 切到本通道并执行
  「显示输出」命令(`workbench.view.output`)。`createOutputChannel(name)`:名 1–128 字符,每实例 ≤ 16 个,`dispose` 立即移除。
- 插件停用(scoped app 吊销):额外通道移除,默认通道保留(重载后仍看得到上次的输出与失败日志)且仍可 `append`(onunload 记日志);
  `show` / `createOutputChannel` 抛 `PERMISSION_DENIED`。卸载 → 移除该插件全部通道。
- 宿主写入默认通道,行格式 `YYYY-MM-DD HH:MM:SS.mmm [error] <消息>`:
  - 插件转 failed(激活 / 加载 / 渲染出错;被禁用 / 卸载中止的不算)→ 本地化原因(带位置,同插件页)。
  - 无效插件目录(plugin-dev-experience)→「Not loaded: <原因>」,同一原因只记一次。
  - window `error` / `unhandledrejection`、贡献回调(命令 / 按钮…)失败:堆栈最靠栈顶的 `continuo-plugin://<id>/` 帧属于本窗口
    已登记的插件 → 记「Uncaught error: …」/「“<动作>” failed: …」并附堆栈;没有插件帧 → 不记(不拦截默认行为)。
- 「输出」面板:没有任何通道 → 只显示空状态;否则标题栏通道下拉(menuitemradio)、清除输出、自动滚动开关(`aria-pressed` = 已锁定);
  内容变化时未锁定滚到底;手动上滚即锁定、滚回底部即解锁。三语。
