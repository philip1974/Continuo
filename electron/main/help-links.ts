// 帮助菜单的外链与「关于」对话框(VSCode helpActions OpenDocumentationUrlAction / update ShowCurrentReleaseNotesAction /
// issue.contribution「报告问题」/ ShowAboutDialogAction)。链接同 package.json 的 homepage / bugs.url(BDD 校验两者一致)。
// BDD: src/__tests__/app-menu-bar/
import os from 'node:os';
import { app, BrowserWindow, clipboard, dialog, shell, type MessageBoxOptions } from 'electron';
import type { MainT } from './i18n';

/** 对话框 / 菜单里显示的产品名(app.name 是 package.json 的小写 name,见 user-data-path)。 */
export const PRODUCT_NAME = 'Continuo';

const HOMEPAGE = 'https://github.com/philip1974/Continuo';

export const HELP_LINKS = {
  documentation: HOMEPAGE,
  releaseNotes: `${HOMEPAGE}/releases`,
  reportIssue: `${HOMEPAGE}/issues`,
} as const;

/** 只允许 https 外链(菜单里的链接都是常量,这里再兜一层,不把别的 scheme 交给系统打开)。 */
export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** 用系统浏览器打开帮助链接;非 https → 不打开,返回 false。打开失败(无默认浏览器等)无可提示的内容。 */
export function openHelpLink(url: string, open: (url: string) => Promise<void> = (u) => shell.openExternal(u)): boolean {
  if (!isHttpsUrl(url)) return false;
  void open(url).catch(() => undefined);
  return true;
}

export interface AboutInfo {
  readonly version: string;
  readonly electron: string;
  readonly chromium: string;
  readonly node: string;
  readonly v8: string;
  readonly os: string;
}

export function currentAboutInfo(): AboutInfo {
  return {
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chromium: process.versions.chrome ?? '',
    node: process.versions.node,
    v8: process.versions.v8,
    os: `${os.type()} ${os.arch()} ${os.release()}`,
  };
}

/** 关于对话框的详情(VSCode 桌面版:版本 / Electron / Chromium / Node.js / V8 / OS;复制按钮复制的就是这段)。 */
export function aboutDetail(t: MainT, info: AboutInfo): string {
  return t('menu.help.about_detail', { ...info });
}

/**
 * 「关于」对话框(VSCode NativeDialogHandler.about:原生消息框,按钮「复制」「确定」,复制 = 把详情写进剪贴板)。
 * win:模态于该窗口;没有窗口 → 独立对话框。
 */
export async function showAboutDialog(t: MainT, win: BrowserWindow | undefined, info: AboutInfo = currentAboutInfo()): Promise<void> {
  const detail = aboutDetail(t, info);
  const options: MessageBoxOptions = {
    type: 'info',
    title: PRODUCT_NAME,
    message: PRODUCT_NAME,
    detail,
    buttons: [t('menu.help.about_copy'), t('menu.help.about_ok')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (response === 0) clipboard.writeText(detail);
}
