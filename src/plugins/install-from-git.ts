// 「从 Git 安装 / 更新插件」的结果归一(插件页 Git URL、市场卡片安装 / 更新、市场 Git URL 段三处共用;此前各写一份,
// ok:false 分支按 code 本地化,catch 分支却直接 errorMessage(err) 把带 code 的 main 原文(硬编码中文)露给 en/ko 用户)。
import { coApi } from '@/lib/co-api';
import { localizeErrorByCode } from '@/lib/localize-error';
import { failureOf } from '@/lib/failure-of';

type InstallResult = Awaited<ReturnType<typeof coApi.plugins.installFromGit>>;
type Installed = Extract<InstallResult, { ok: true }>['data'];

export type GitInstallOutcome =
  | { readonly ok: true; readonly data: Installed }
  /** message 已按 code 本地化(未收录的 code 回退原文,原文缺省回退 code)。 */
  | { readonly ok: false; readonly code: string; readonly message: string };

export async function installFromGitLocalized(
  ...args: Parameters<typeof coApi.plugins.installFromGit>
): Promise<GitInstallOutcome> {
  try {
    const r = await coApi.plugins.installFromGit(...args);
    if (r.ok) return { ok: true, data: r.data };
    return { ok: false, code: r.code, message: localizeErrorByCode(r.code, r.message) };
  } catch (err) {
    const { code, message } = failureOf(err);
    return { ok: false, code, message: localizeErrorByCode(code, message) };
  }
}
