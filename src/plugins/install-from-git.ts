// 「从 Git 安装 / 更新插件」的结果归一(插件页 Git URL、市场卡片安装 / 更新、市场 Git URL 段三处共用;此前各写一份,
// ok:false 分支按 code 本地化,catch 分支却直接 errorMessage(err) 把带 code 的 main 原文(硬编码中文)露给 en/ko 用户)。
import { coApi } from '@/lib/co-api';
import { localizeErrorByCode } from '@/lib/localize-error';
import { failureOf } from '@/lib/failure-of';
import { t } from '@/i18n';

type InstallResult = Awaited<ReturnType<typeof coApi.plugins.installFromGit>>;
type Installed = Extract<InstallResult, { ok: true }>['data'];

export type GitInstallOutcome =
  | { readonly ok: true; readonly data: Installed }
  /**
   * message 已按 code 本地化(未收录的 code 回退原文,原文缺省回退 code)。alreadyInstalled:全新安装(非 overwrite)撞
   * EEXIST —— 插件已在盘上但不在本窗口列表(别的窗口刚装、要重启才进列表;待重启记录不跨窗口)。三个入口据此如实提示
   * 「已安装、重启后加载」,而非无从下手的「文件已存在」。existing:EEXIST 时 main 带回的仓库 manifest 身份与版本
   *(据此用插件名提示;该 id 已在本窗口列表时可确认后覆盖更新)。
   */
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly alreadyInstalled: boolean;
      readonly existing?: Installed;
    };

export async function installFromGitLocalized(
  ...args: Parameters<typeof coApi.plugins.installFromGit>
): Promise<GitInstallOutcome> {
  const overwrite = args[1] === true;
  const fail = (code: string, message: string | undefined, details?: Readonly<Record<string, string>>): GitInstallOutcome => {
    const localized = localizeErrorByCode(code, message);
    const detail = code === 'GIT_FAILED' ? gitFailureDetail(message) : undefined;
    const alreadyInstalled = !overwrite && code === 'EEXIST';
    const existing = alreadyInstalled ? installedFromDetails(details) : undefined;
    return {
      ok: false,
      code,
      // GIT_FAILED 的本地化标题(「Git 命令失败」)会整段替换 main 原文,原因(断网 / 404 / 需鉴权 / 分支不存在)随之丢失 →
      // 附上 git 自己的报错行(git 输出,不属于硬编码文案泄漏)。
      message: detail ? t('common.label_detail', { label: localized, detail }) : localized,
      alreadyInstalled,
      ...(existing ? { existing } : {}),
    };
  };
  try {
    const r = await coApi.plugins.installFromGit(...args);
    if (r.ok) return { ok: true, data: r.data };
    return fail(r.code, r.message, r.details);
  } catch (err) {
    const { code, message } = failureOf(err);
    return fail(code, message);
  }
}

/** EEXIST 的 details → 插件身份与版本(三个字段都是非空字符串才算)。 */
function installedFromDetails(details: Readonly<Record<string, string>> | undefined): Installed | undefined {
  const id = details?.['id'];
  const name = details?.['name'];
  const version = details?.['version'];
  return id && name && version ? { id, name, version } : undefined;
}

/**
 * main 的 GIT_FAILED 原文形如 `git clone exit 128: <stderr>`:取 stderr 中最有信息量的一行(优先 fatal: / error:,
 * 否则首个非空行);无 stderr 返回 undefined。
 */
export function gitFailureDetail(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const m = /^git \S+ exit [^:]*: ?([\s\S]*)$/.exec(message);
  const lines = (m ? m[1]! : '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  return lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0];
}

/** Git URL 的仓库名(末段去 `.git`),用于尚不知插件名时的提示。 */
export function repoNameFromGitUrl(url: string): string {
  const tail = url.trim().replace(/[/\\]+$/, '').split(/[/\\:]/).pop() ?? url;
  return tail.replace(/\.git$/i, '') || url;
}
