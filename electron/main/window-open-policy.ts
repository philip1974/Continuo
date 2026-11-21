// window.open(dockview popout 等)的目标是否是本应用自己的 renderer 入口。是 → 允许开子窗并注入 preload;
// 否 → 拒绝(http(s) / mailto 外链另行交给系统打开)。
//
// 判定必须与主窗的加载方式一致(见 index.ts createMainWindow):
//  - 有可用的 dev server URL(未打包且设了 ELECTRON_RENDERER_URL)→ 主窗 loadURL,子窗只认同源;
//  - 否则(已打包,或未打包但直接跑构建产物:预览 / e2e)→ 主窗 loadFile,子窗只认受信的 renderer 文件入口
//    (精确 pathname,不放行任意 file://,否则恶意 file:// 弹窗会被注入全量 preload)。
// 此前只按「是否打包」分支:未打包且没有 dev server 时要求同源 dev URL,而它不存在 → 所有 popout 被拒。

import { MAX_WINDOW_URL_LEN } from '../shared/url-limits';

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

interface NavigationGuardContents {
  on(
    event: 'will-navigate',
    listener: (event: { preventDefault(): void; readonly url: string }) => void,
  ): void;
}

// 主框架导航只允许回到本应用自己的 renderer 入口。页面内容里的 <a href>(只读 Markdown 预览的
// 链接、mermaid 图的 click 链接等)被点击时,默认行为是把整个窗口导航过去 —— 应用界面被外部网页
// 顶替。renderer 侧各自拦 click 是第一道,这里是兜底:拦下导航,把 URL 交给 onBlocked。
export function installNavigationGuard(
  contents: NavigationGuardContents,
  isOwnRendererUrl: (url: string) => boolean,
  onBlocked: (url: string) => void,
): void {
  contents.on('will-navigate', (event) => {
    // 守卫装在所有 webContents 上,包括 DevTools 前端 —— 它自己的 devtools:// 导航不归这里管。
    if (event.url.startsWith('devtools://')) return;
    if (isOwnRendererUrl(event.url)) return;
    event.preventDefault();
    // 只拦不转交的话漏网的链接点击对用户就是「没反应」:交回调用方按外链白名单处理。
    onBlocked(event.url);
  });
}
