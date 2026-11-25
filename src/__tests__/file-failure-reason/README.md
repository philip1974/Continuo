# file-failure-reason(打开 / 保存失败提示:动作 + 文件名 + 本地化原因)

## 背景

- 真实磁盘满保存失败只弹「文件 I/O 错误」:看不出是哪个文件、什么动作;ENOSPC / EROFS 都被归为 FS_IO。
- 打开悬空符号链接 / 刚被外部删除的文件:三语都显示英文原文与完整绝对路径(「打开失败 dangling:readFile failed:
  /private/tmp/…/dangling」)—— `errors.FS_NOT_FOUND` 带 `{path}` 占位,调用点只有 code + message,
  `localizeErrorByCode` 缺参时回退原文。

## 行为(对齐 VSCode「Failed to save 'note.txt': …」「Unable to open 'x': …」)

- 保存失败(⌘S / 关闭脏 tab「保存」/ 覆盖确认后的重试)→ `common.label_detail`:「保存失败 <文件名>:<按 code 本地化的原因>」,
  与打开失败「打开失败 <文件名>:<原因>」同一格式(`src/notifications/notify-open-failed.ts` fileFailureText)。
- 自动保存失败提示同样带文件名:「自动保存失败 <文件名>:<原因>」。
- errno 细分:ENOSPC → `FS_NO_SPACE`(磁盘空间不足)、EROFS → `FS_READONLY_FS`(文件系统是只读的),三语文案;
  其余未知 errno 仍 `FS_IO`。
- 守卫:经 `localizeErrorByCode` / `notifyFailure` 按 code 展示的 `errors.<UPPER_CODE>` 文案不含占位符 ——
  名字 / 路径由调用点的标签给出。`FS_NOT_FOUND`、`WORKSPACE_NOT_ABSOLUTE / NOT_DIRECTORY / NOT_FOUND` 改为无参文案
  (此前缺参全部回退英文原文)。唯一例外 `EDITOR_DISK_CHANGED`(显式保存走确认框;自动保存提示传 `{ hotkey }`)。
