// window.open(dockview popout 等)的目标是否是本应用自己的 renderer 入口。是 → 允许开子窗并注入 preload;
// 否 → 拒绝(http(s) / mailto 外链另行交给系统打开)。
//
// 判定必须与主窗的加载方式一致(见 index.ts createMainWindow):
//  - 有可用的 dev server URL(未打包且设了 ELECTRON_RENDERER_URL)→ 主窗 loadURL,子窗只认同源;
//  - 否则(已打包,或未打包但直接跑构建产物:预览 / e2e)→ 主窗 loadFile,子窗只认受信的 renderer 文件入口
//    (精确 pathname,不放行任意 file://,否则恶意 file:// 弹窗会被注入全量 preload)。
// 此前只按「是否打包」分支:未打包且没有 dev server 时要求同源 dev URL,而它不存在 → 所有 popout 被拒。

import { MAX_WINDOW_URL_LEN } from '../shared/url-limits';
import { isPopoutOnlyUrl } from './popout-url';

export function isOwnRendererWindowUrl(
  url: string,
  devRendererUrl: URL | null,
  isTrustedRendererFile: (url: string) => boolean,
): boolean {
  // 超长 URL 必不是本应用入口:先于 new URL 解析拒掉(导航守卫每次导航都经此,不受 window.open
  // 那条路径上的 MAX_EXTERNAL_URL_LEN 前置闸保护)。
  if (typeof url !== 'string' || url.length > MAX_WINDOW_URL_LEN) return false;
  if (devRendererUrl === null) return isTrustedRendererFile(url);
  try {
    return new URL(url).origin === devRendererUrl.origin;
  } catch {
    return false;
  }
}

interface NavigationGuardEvent {
  preventDefault(): void;
  readonly url: string;
  readonly isMainFrame: boolean;
}

interface NavigationGuardContents {
  getURL(): string;
  on(event: 'will-frame-navigate', listener: (event: NavigationGuardEvent) => void): void;
}

/**
 * 唯一放行的「页面自行刷新」:dev(有 dev server,allowSameUrlReload)下主框架刷新到**当前同一 URL**(Vite HMR
 * 整页刷新 / location.reload())。打包版不放行(页面无权自行刷新:漏网的空链接会丢未保存内容);带别的参数 /
 * 别的入口照拦(防页面以任意启动参数重开窗口)。导航守卫与 wc-gone-hook 共用本判定:放行 ⇔ 视为 reload 回收资源。
 */
export function isAllowedPageReload(
  url: string,
  currentUrl: string,
  allowSameUrlReload: boolean,
  isOwnRendererUrl: (url: string) => boolean,
): boolean {
  return allowSameUrlReload && currentUrl !== '' && url === currentUrl && isOwnRendererUrl(url);
}

// 页面发起的跨文档导航(任何 frame:<a href> 点击、location 赋值、location.reload()、iframe 加载)一律拦下,
// dev 与打包版同一套规则(唯一差异:dev 下放行同 URL 刷新,见 isAllowedPageReload)。窗口内容只由 main 经 loadURL / loadFile / webContents.reload() 加载 —— 浏览器侧
// 发起,Electron 不为它们发 will-frame-navigate。挂 will-frame-navigate 而非 will-navigate:前者对主框架与
// 子 frame 都发,且先于 will-navigate;在这里 preventDefault 后 will-navigate 不再发。
// 页面内容里的链接(只读 Markdown 预览、mermaid 图的 click 链接等)renderer 侧各自拦 click 是第一道,这里是兜底。
export function installNavigationGuard(
  contents: NavigationGuardContents,
  isOwnRendererUrl: (url: string) => boolean,
  onBlocked: (url: string) => void,
  isPageReloadAllowed: (url: string, currentUrl: string) => boolean = () => false,
): void {
  contents.on('will-frame-navigate', (event) => {
    const { url, isMainFrame } = event;
    // 唯一放行:popout 子窗的首次加载。windowOpenHandler 放行 window.open 后,子窗 webContents 的首次加载
    // 也是页面发起的导航,拦下就是空白子窗。条件与 windowOpenHandler 的放行一致,且子窗尚未提交任何文档
    //(之后的导航、opener 抢先改 w.location 指向别处,都照拦)。
    if (isMainFrame && contents.getURL() === '' && isOwnRendererUrl(url) && isPopoutOnlyUrl(url)) {
      return;
    }
    if (isMainFrame && isPageReloadAllowed(url, contents.getURL())) return;
    event.preventDefault();
    if (!isMainFrame) return;
    // DevTools 自己的 devtools:// 导航与指回本应用入口的导航(含打包版的 location.reload())
    // 只拦不转交:后者在 dev 下是 http://localhost,转交会被外链白名单放行、开到系统浏览器里。
    if (url.startsWith('devtools://')) return;
    if (isOwnRendererUrl(url)) {
      console.warn('[nav-guard] blocked page-initiated navigation to the app entry; use View > Reload');
      return;
    }
    // 只拦不转交的话漏网的链接点击对用户就是「没反应」:交回调用方按外链白名单处理。
    onBlocked(url);
  });
}
