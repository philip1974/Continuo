# plugin-fs scope 授权弹窗的显示路径

行为契约:**fs scope 授权弹窗展示的是用户实际授予的绝对路径**(`~` 已展开、符号链接已解析),
而不是插件请求里的原始字符串。

## 背景

渲染进程运行在 sandbox 中,没有 `process`,无法自己展开 `~`。此前 renderer 读
`process.env.HOME` 来展开,生产环境里恒读不到 → 弹窗始终显示原始的 `~/…`(对应单测靠桩
`process` 通过)。路径归一化只有 main 做得了,且 main 落地授权时用的就是归一化后的路径。

## main:`plugin-fs:scope-request` 推送

- 每个 scope 带 `displayPath`,值为该 scope 归一化后的路径(与授权落地进 registry 的路径同源):
  - `~/dir` → `<home>/dir`
  - 已是绝对路径且无符号链接 → 原样
- `path` / `mode` 仍是插件请求的原始值(决策回传与关联不变)。
- `displayPath` 与 `scopes` 按下标一一对应。

## renderer:弹窗 scope 列表

- payload 的 scope 带合法 `displayPath`(非空字符串,长度 ≤ `FS_PATH_MAX`)→ 弹窗显示它。
- 不带 `displayPath`(旧形态)→ 回退显示原始 `path`。
- `displayPath` 非字符串 / 空串 / 超长 → 整个 payload 视为畸形,drop + warn,不进弹窗队列。
- renderer 不读 `process` / 环境变量。

## 不在本主题验证

- 归一化本身(`~` 展开、realpath、`~user` 退化)→ `49-polish-bugfixes/scope-grant-canonicalizes-path`。
- 决策回传失败反馈、ingress 其余字段校验 → `plugin-fs-scope-bridge`。
