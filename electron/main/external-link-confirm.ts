// 打开外部 http(s) 链接前的确认(VSCode OpenerValidatorContributions.validateLink,
// src/vs/workbench/contrib/url/browser/trustedDomainsValidator.ts):链接不在受信域名内 → 确认框「是否要让 Continuo 打开外部
// 网站?」+ 完整地址,按钮「打开」「复制」「配置受信任的域」「取消」;「配置受信任的域」给出 信任 <源> / 信任 <域名> 及其所有子域 /
// 信任所有域 / 管理受信任的域(VSCode configureOpenerTrustedDomainsHandler 的快速选择)。
// 用 main 的原生对话框:是否打开由 main 决定,页面内容(Markdown、终端输出、插件页)无法伪造「已确认」。
// BDD: src/__tests__/external-link-trusted-domains/
import { BrowserWindow, clipboard, dialog, type MessageBoxOptions } from 'electron';
import { getMainT } from './i18n';
import { PRODUCT_NAME } from './help-links';
import { isUrlTrusted, trustChoicesFor, type TrustChoice } from '../shared/trusted-domains';
import {
  addUserTrustedDomain,
  getEffectiveTrustedDomains,
  isTrustedDomainsPersistBlocked,
} from './services/trusted-domains.service';
import { sendMenuCommand } from './lib/menu-command';

/** 确认框里显示的地址:WHATWG 规范化后的完整 href(主机名为 punycode,同形字域名一眼可辨;不截断)。 */
export function displayUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

async function showBox(win: BrowserWindow | null, options: MessageBoxOptions): Promise<number> {
  const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return r.response;
}

function choiceLabel(t: ReturnType<typeof getMainT>, c: TrustChoice): string {
  switch (c.kind) {
    case 'origin':
      return t('link.trust.origin', { origin: c.label });
    case 'subdomains':
      return t('link.trust.subdomains', { domain: c.label });
    case 'all-ports':
      return t('link.trust.all_ports', { host: c.label });
    case 'all':
      return t('link.trust.all');
  }
}

/**
 * 「配置受信任的域」:选了信任某项 → 写入并按新列表判定是否打开;「管理」→ 打开设置页的受信任的域;取消 → 不打开。
 * 读盘失败(本次修改存不下来)时在地址下方写明,不让用户以为已经永久信任。
 */
async function configureTrustedDomains(url: string, win: BrowserWindow | null): Promise<boolean> {
  const t = getMainT();
  const choices = trustChoicesFor(url);
  const buttons = [...choices.map((c) => choiceLabel(t, c)), t('link.trust.manage'), t('link.confirm.cancel')];
  const notSaved = (await isTrustedDomainsPersistBlocked()) ? `\n\n${t('settings.trusted_domains.not_saved')}` : '';
  const response = await showBox(win, {
    type: 'question',
    title: PRODUCT_NAME,
    message: t('link.trust.title'),
    detail: displayUrl(url) + notSaved,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  });
  const picked = choices[response];
  if (picked) {
    const list = await addUserTrustedDomain(picked.pattern);
    return isUrlTrusted(url, list);
  }
  if (response === choices.length) sendMenuCommand(win ?? undefined, 'workbench.action.manageTrustedDomain');
  return false;
}

/**
 * 是否打开这个 http(s) 链接:受信 → true(不问);否则弹确认。「复制」把地址写进剪贴板、不打开。
 * @param win 确认框挂在哪个窗口上(发起点击的窗口);null → 独立对话框
 */
export async function confirmOpenExternal(url: string, win: BrowserWindow | null): Promise<boolean> {
  if (isUrlTrusted(url, await getEffectiveTrustedDomains())) return true;
  const t = getMainT();
  const buttons = [t('link.confirm.open'), t('link.confirm.copy'), t('link.confirm.configure'), t('link.confirm.cancel')];
  const response = await showBox(win, {
    type: 'info',
    title: PRODUCT_NAME,
    message: t('link.confirm.message', { product: PRODUCT_NAME }),
    detail: displayUrl(url),
    buttons,
    defaultId: 0,
    cancelId: 3,
    noLink: true,
  });
  if (response === 0) return true;
  if (response === 1) {
    clipboard.writeText(url);
    return false;
  }
  if (response === 2) return configureTrustedDomains(url, win);
  return false;
}
