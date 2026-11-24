# 对话框的可访问说明(aria-describedby / alertdialog)

行为契约:**确认框与授权弹窗打开时,读屏除了标题和焦点按钮,还要读到说明正文。** 焦点初始落在「取消」/「拒绝」上时,
若对话框没有 `aria-describedby`,读屏只读「标题 + 取消 按钮」—— 磁盘冲突框的文件名与三个按钮的含义、终止终端框的进程名、
删除确认的文件列表与「有未保存更改」警告、授权弹窗请求的动作 / 插件 / 路径都听不到。

参考 WAI-ARIA APG(Dialog (Modal) / Alert Dialog 模式):对话框用 `aria-describedby` 指向说明区;
需要用户立即响应、可能造成数据丢失的确认用 `role="alertdialog"`。design `Modal` 的 `role` / `aria-*` 由调用方经
普通 HTML 属性覆盖(`role="dialog"` 写在 `{...rest}` 之前),无需新增 Modal API。

## 模块

| 文件 | 职责 |
|---|---|
| `src/lib/ConfirmDialog.tsx` | 所有确认框(关闭脏文件、磁盘冲突、删除到废纸篓、终止终端、卸载插件、撤销授权、最近目录不存在等)共用 |
| `src/shell/AgentAuthPrompt.tsx` | Agent(MCP)授权弹窗 |
| `src/plugins/permissions/PermissionPrompt.tsx` | 插件权限弹窗(manifest 权限 / fs-scope 路径两种形态) |

## 规范文件

- `dialog-description.spec.tsx`

## 关键行为

- D1 `ConfirmDialog` 的说明区(description)有唯一 id,对话框 `aria-describedby` 指向它;同时打开两个实例 id 不冲突。
- D2 `destructive` 确认框是 `role="alertdialog"`(仍 `aria-modal` + `aria-labelledby` 标题);非 destructive 保持 `role="dialog"`。
- D3 Agent 授权弹窗 `aria-describedby` 覆盖请求说明(含请求的动作名)、外部调用方提示与授权后果说明;不含按钮文字。
- D4 插件权限弹窗 manifest 形态 `aria-describedby` 覆盖说明句(含插件 id)与「部分授予」提示;fs-scope 形态覆盖说明句与申请的路径 / 读写模式列表。
- 授权弹窗保持 `role="dialog"`(是否授权是用户主动选择,不是警告;e2e / 规范按 dialog 定位)。
