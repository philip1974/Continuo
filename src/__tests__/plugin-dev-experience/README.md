# plugin-dev-experience — 插件作者视角:无效插件可见、加载错误可定位、运行中修好即生效

第六十七轮 B 组审计(插件作者视角)发现:写错 manifest / 入口的插件在界面上直接消失,原因只在 DevTools / 主进程 stdout;
入口以 Blob URL 加载,堆栈无文件名、断点跨重载失效、source map 失效;语法错误不给行号;多文件 ESM 报错晦涩;
未声明权限只报 `Permission denied: fs`。

## 对齐 VSCode

- 无效扩展仍出现在扩展视图,状态里显示 validations 的错误(`extensionsActions.ts` `ExtensionStatusAction`:
  `!extension.local.isValid` → 以 warning 图标显示 `validations` 中 Severity.Error 的消息;扫描端
  `extensionsScannerService.ts` 产出 `isValid` + `validations`)。
- 激活失败弹通知并记进日志(`abstractExtensionService.ts` `_handleExtensionPointMessage` / 激活错误)。
- 扩展代码以真实文件 URL 加载,堆栈、断点、source map 都按文件。Continuo 入口经 Blob 加载,用稳定的 `//# sourceURL` 达到同样效果。

## 行为契约

### 无效插件不再消失(`manager.spec.ts`、`main-side.spec.ts`、`texts-and-permissions.spec.tsx`、`plugins-tab-content.spec.tsx`)

- main 列举(`LIST_DIRS`)把「目录名 ≠ manifest.id」「main 入口不可用」的目录带结构化原因返回
  (`skip: { code: PLUGIN_DIR_NAME_MISMATCH | PLUGIN_MAIN_UNAVAILABLE, params }`),不再只在 stdout 告警。
  主进程内部的 `listPluginDirs(baseDir)` 默认仍只返回可激活目录。
- renderer 把准入失败的目录(上述两类 + `INVALID_JSON` / `SCHEMA_ERROR` / `INCOMPATIBLE_VERSION`)登记为**无效插件行**
  (`PluginManager.listInvalid()`):名称 / id / 版本(manifest 里是字符串时)、「无效」标记、文件夹、本地化原因(role=alert,
  `data-code` 留原始 code)、「修好后保存即可,无需重启」提示;只读,没有操作按钮。目录名已登记为插件的不重复成无效行
  (失败显示在插件自己的行上)。
- `SCHEMA_ERROR` 带字段级问题(`parseManifest` 的 `issues`:`path` + 归一化的 `code` + 参数),逐条按 code 本地化;
  manifest 校验文案不再有中文硬编码(id 规则的英文兜底 + `id_format` 本地化)。
- `PluginFailureNotifier` 对无效行通知一次(按目录 + 原因签名去重;原因变了再通知;消失后再出现再通知)。

### 运行中新放入 / 修好的插件无需重载窗口(`main-side.spec.ts`、`manager.spec.ts`、`plugin-reload-gate`)

- main 文件监视:首轮之后**新出现的 id** 也广播(此前只广播已记录的目录);manifest 不是合法 JSON 的目录(按目录名)、
  main 入口不可用的目录(按 manifest.id)出现 / 改动 / 消失各广播一次;同一轮同一 id 只广播一次。
- renderer `handleDirChanged(id)`:已登记 → 热重载(`reload`);未登记 → 重新扫描:登记新出现的合格插件
  (`adoptInstalled(id, { prompt: false })`,盘上启用的照常激活,需授权的只登记)、刷新无效插件行。
- 已登记插件的 manifest 变成非法 JSON / 入口被删 → 插件行 `failed`(`INVALID_JSON` / `PLUGIN_MAIN_UNAVAILABLE`),
  不再报「已不存在」;修好后按启用意图重新激活。
- 登记后监视器就这次安装 / 放入的那次广播(目录与登记时相同)跳过,不 onload / onunload / onload 三连;改了 main 照常热重载。
- 监视器先以 `prompt:false` 登记(需授权 → 「等待别处授权」)后,本窗口发起的安装(`adoptInstalled` 默认 prompt)照常激活并弹授权。

### 加载错误可定位(`manager.spec.ts`、`main-side.spec.ts`、`texts-and-permissions.spec.tsx`)

- 入口生成 Blob 前追加 `//# sourceURL=continuo-plugin://<id>/<main>`(只在末尾加行,行号不变):堆栈 / DevTools 源码树显示
  该地址,断点按它记、跨重载保留(e2e 用 CDP `Debugger.setBreakpointByUrl` 验证)。
- `READ_MAIN_BY_DIR` 把入口末尾的相对 `//# sourceMappingURL=` 内联成 data URL:只读插件目录内(realpath 包含)的普通文件、
  ≤ 16 MiB;data: / 带 scheme / 绝对路径 / 越界 / 超限 / 不存在一律原样。
- 入口 import 报 `SyntaxError` → 经 `CHECK_MAIN_SYNTAX` 在 main 侧以 Electron-as-Node `--input-type=module --check` 检查(V8 只编译
  **不执行**;干净环境变量,不继承 NODE_OPTIONS),得到 1 起的行列号 → `IMPORT_SYNTAX_ERROR` + `location`。
- 入口 import 了相对 / 裸模块 → `IMPORT_UNBUNDLED`(`params.specifier`、`kind`),本地化提示须打包成单文件 ESM(README 附 esbuild / vite 示例)。
- 构造 / onload / 模块顶层抛错 → error 带堆栈里本插件最靠栈顶的帧位置(`main.js:3:9`);插件行与通知显示「原因(位置)」。

### 权限错误区分「未声明」与「用户拒绝」(`texts-and-permissions.spec.tsx`)

- manifest 未声明 → `PermissionError` `code: 'PERMISSION_NOT_DECLARED'`,消息指明在 `manifest.json` 的 `permissions` 里加什么;
  已声明但用户拒绝 → `code: 'PERMISSION_DENIED'`,指向「设置 › 插件」。二者带 `i18nKey` + `params.permission`,`localizeThrown` 据此按
  `plugin_permission.*` 三语本地化(`errors.<CODE>` 文案不得含占位符);不带 key 的 `PERMISSION_DENIED`(停用吊销等)仍显示原 message。
