# save-readonly-file(保存写保护文件:拒绝静默覆盖,显式保存经确认后才覆盖)

## 背景

原子写(同目录 tmp + `rename(tmp → 路径)`)替换的是目录项:目录可写即可绕过文件自身的写保护。外部 `chmod 444`
后在编辑器里 ⌘S,此前无任何提示、标签变已保存、磁盘内容被改写(tmp 继承 0444 后 rename,权限仍 444)。

## 行为(对齐 VSCode「Failed to save: File is write-protected. Select 'Overwrite' to attempt to remove protection」)

主进程 `electron/main/ipc/fs/atomic-write.ts` 覆盖已有普通文件前检查写保护:mode 无任何写位(`mode & 0o222 === 0`,
Windows 只读属性 `attrib +R` 即映射为此)或对当前用户不可写(`fs.access(W_OK)` 得 EACCES / EPERM)→ 抛 `FS_READONLY`,
不写、不改权限。新建文件 / 可写文件不受影响。

| 写入口 | 走的写入器 | 遇写保护 |
|---|---|---|
| 编辑器保存(⌘S、工具栏、关闭脏 tab 选「保存」、关窗「保存」、自动保存)`fs:write-file` | `atomicWriteFile` | `FS_READONLY`;仅显式保存在用户确认后带 `overwriteReadonly: true` 重试 |
| 插件 `app.fs.writeFile`(`plugin-fs:write-file`) | `atomicReplaceFileNoFollow` | 直接 `FS_READONLY`,无覆盖选项(插件不应替用户去掉写保护) |
| 外部文件拖入 Explorer 覆盖同名(`fs:write-binary`) | `atomicReplaceFileNoFollow` | 同上 |
| MCP `install_stop_hook` 写 agent CLI 配置 | `atomicReplaceFileNoFollow` | 同上(MCP 无通用写文件工具) |

渲染端(`EditorPanel.tsx`):

- 显式保存 / 关闭脏 tab 选「保存」/ 外部修改「仍然覆盖」后遇 `FS_READONLY` → 确认框「文件是只读的 —— 覆盖 / 取消」
  (destructive,初始焦点在「取消」),不弹错误 toast。
- 取消 → 不写,tab 仍脏。覆盖 → `saveFile(id, { overwriteReadonly: true, force? })`:主进程按 VSCode unlock
  语义给原文件加属主写位(`chmod mode | 0o200`;Windows 即清只读属性;非属主 EPERM → `FS_DENIED`)后原子写,
  **不恢复**写保护(同 VSCode)。来自关闭 tab 的「保存」→ 覆盖成功后关闭。
- 自动保存遇 `FS_READONLY`:不弹框、不带 `overwriteReadonly` 重试;tab 保持脏、关窗计数不豁免,
  复用自动保存失败提示「自动保存失败 <文件名>:文件是只读的(写保护)」(见 file-failure-reason)。
- 关窗流程「保存」遇写保护:计入保存失败,中止关窗(同其它保存失败,不在关窗握手里弹覆盖框)。

## 残余

- 检查与 rename 之间文件被外部改成只读(TOCTOU):本次仍写入;同 VSCode 不加锁。
