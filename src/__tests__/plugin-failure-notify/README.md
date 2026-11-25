# plugin-failure-notify — 插件激活 / 渲染失败主动提示,错误文案本地化

## 背景 / 缺陷

- 插件激活失败(权限被拒、入口加载失败、onload 抛错…)此前只 `console.warn`,用户只有翻到「设置 › 插件」才看得到。
- 插件行错误文案对未收录的错误码回退成 `CODE: message`(如 `PERMISSION_DENIED: fs, network`),原始错误码直接给用户看。

## 对齐 VSCode

扩展激活失败弹 error 通知(「Activating extension 'x' failed: …」)并指向扩展视图;扩展视图里显示可读的错误原因。
Continuo 的 `notify` 不支持通知内按钮 → 文案里指引「可在「设置 › 插件」中重试或禁用」。

## 行为契约

- `localizePluginError({ code, message })`(`src/plugins/plugin-error-text.ts`)—— 插件行、通知、市场卡片共用:
  - `PERMISSION_DENIED` → 「所需权限已被拒绝:{perms}」(message 即被拒权限列表);
  - `IMPORT_FAILED` → 「插件入口加载失败:{message}」;`RENDER_FAILED` → 「界面渲染出错:{message}」;
  - `errors.<CODE>` 已收录(如 `NO_DEFAULT_EXPORT`、插件抛的 `FS_DENIED`)→ 该本地化文案;
  - 其余(`EXCEPTION` 等)→ 「激活失败:{message}」。不再出现 `CODE: message`。
- `PluginFailureNotifier`(主窗常驻,`src/plugins/PluginFailureNotifier.tsx`)订阅插件列表:插件进入 `failed`
  → `notify.error` 一次「插件「{name}」{原因}。可在「设置 › 插件」中重试或禁用。」(带 code)。
  - 去重:同一插件保持同一失败不重复通知;离开 failed(重新启用成功 / 禁用)后再失败,或失败原因变了,再通知。
  - 挂载前已发生的失败(启动期激活早于通知层就绪)挂载时补发。
  - 被禁用 / 卸载中止的激活(`ACTIVATION_ABORTED` / `NOT_INSTALLED`)不是失败,不通知。
- 插件行:错误文案用 `localizePluginError`(`data-code` 保留原始 code 供排查);`failed` 行除「启用」(重试)外
  也给「禁用」—— 否则激活失败的插件每次启动都重试、且渲染出错时仍在运行的实例在插件页停不掉。
