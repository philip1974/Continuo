import { tWithFallback } from '@/i18n';

/**
 * i18n(I6/I7,codex 复查 P1):把 main/IPC 返回的「带稳定 code 的 error」在 renderer 展示前
 * 按 `errors.<CODE>` catalog 本地化。
 *
 * `errors.*` 是 main/renderer 共享的双语权威(en/zh/ko 全集)。直接展示 main 返回的 raw
 * `message` 会**双向泄漏**:main 中文 message → en/ko 看到中文;main 英文/技术 message →
 * zh/ko 看到英文。统一按 code 经 catalog 翻译:命中 catalog 用本地化文案,未收录的 code
 * (动态错误,如网络/未知异常)回退原 message(保留细节)。
 *
 * 所有「error toast / 错误反馈展示」入口的单一来源(Explorer FolderTree FS toast、Editor
 * 保存失败、等)。新增展示 main error 的入口都应走这里,不要直接 notify.error(r.message)。
 */
export function localizeErrorByCode(code: string, message: string): string {
  const localized = tWithFallback(`errors.${code}`, message);
  // 占位符守卫:有些 catalog 模板含插值参数(如 errors.FS_NOT_FOUND='File not found:
  // {path}'、errors.WORKSPACE_NOT_FOUND='...: {workspace}')。本 helper 只有 code+message
  // 无 params,直接返回会渲染**字面 `{path}`**。这类情形退回原 message(main 的 raw message
  // 通常已含具体路径/细节,比露占位符好)。非参数化 code(FS_DENIED/FS_IO/FS_EEXIST 等
  // 绝大多数)正常本地化。
  if (/\{[A-Za-z_]\w*\}/.test(localized)) return message;
  return localized;
}
