import { tWithFallback, type TranslateParams } from '@/i18n';
import { errorMessage } from '@shared/error-message';
import { ERROR_CODES } from '@shared/error-codes';

function isPlaceholderStart(code: number): boolean {
  return (
    code === 95 ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isPlaceholderRest(code: number): boolean {
  return isPlaceholderStart(code) || (code >= 48 && code <= 57);
}

function hasCatalogPlaceholder(text: string): boolean {
  for (let i = 0; i < text.length - 2; i += 1) {
    if (text.charCodeAt(i) !== 123) continue;
    const first = text.charCodeAt(i + 1);
    if (!isPlaceholderStart(first)) continue;
    let end = i + 2;
    while (end < text.length && isPlaceholderRest(text.charCodeAt(end))) {
      end += 1;
    }
    if (text.charCodeAt(end) === 125) return true;
    i = end;
  }
  return false;
}

/**
 * i18n(I6/I7,复查 P1):把 main/IPC 返回的「带稳定 code 的 error」在 renderer 展示前
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
/**
 * main 已按当前语言写好完整说明的 code:message 带 catalog 文案装不下的具体信息,有 message 就原样显示。
 * FS_SAVE_ORIGINAL_DAMAGED:原地保存失败且没能还原原文件,message 含完整原内容的恢复副本路径(见 fs.ipc saveEditorFile)。
 */
const MAIN_LOCALIZED_CODES: ReadonlySet<string> = new Set([ERROR_CODES.FS_SAVE_ORIGINAL_DAMAGED]);

export function localizeErrorByCode(code: string, message?: string | null, params?: TranslateParams): string {
  if (MAIN_LOCALIZED_CODES.has(code) && message) return message;
  // 原文缺省 / 空串 → 回退 code(未收录 code 时不显示空原因)。此前由各调用点自带回退,写法分成 `||` / `??` / 不回退三种。
  const fallback = message || code;
  const localized = tWithFallback(`errors.${code}`, fallback, params);
  // 占位符守卫:有些 catalog 模板含插值参数(如 errors.FS_NOT_FOUND='File not found:
  // {path}'、errors.WORKSPACE_NOT_FOUND='...: {workspace}')。本 helper 只有 code+message
  // 无 params(调用方未传),直接返回会渲染**字面 `{path}`**。这类情形退回原 message(main 的 raw message
  // 通常已含具体路径/细节,比露占位符好)。非参数化 code(FS_DENIED/FS_IO/FS_EEXIST 等
  // 绝大多数)正常本地化。
  if (hasCatalogPlaceholder(localized)) return fallback;
  return localized;
}

/**
 * catch 到的任意值 → 展示文本:带 string `code` 按 catalog 本地化(localizeErrorByCode),否则原 message。
 * 与 errorCodeOf 不同,无 code 时不兜底成 'EXCEPTION'。null / undefined 也安全(插件回调可 reject(null))。
 */
export function localizeThrown(err: unknown): string {
  const message = errorMessage(err);
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? localizeErrorByCode(code, message) : message;
}
