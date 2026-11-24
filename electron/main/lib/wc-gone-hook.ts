// 「该 webContents 名下的 main 侧资源该清了」的统一钩子(plugin-mcp 的工具 stub 与 plugin-shell-stream
// 的在途子进程此前各手写一份,后者注释自称「镜像」前者)。两种时机都要清:
//   - destroyed:窗口 / webContents 销毁;
//   - did-start-navigation(main frame 且非同文档):renderer reload(Ctrl+R / 菜单 View → Reload /
//     webContents.reload())—— webContents 不销毁、id 不变,但 renderer 侧状态被整体撕掉重建,不会有任何
//     「我要走了」的通知。须在新文档脚本执行前清掉残留;hash / pushState(同文档)不算。
// 每个 webContents 只挂一次(按对象身份记,反复 reload 复用同一持久监听)。回调须幂等。
//
// 只把浏览器侧发起、目标为本应用 renderer 入口的导航视为 reload:Electron 先发 did-start-navigation 再发
// will-frame-navigate,导航守卫(installNavigationGuard)在那里 preventDefault 拦下页面发起的导航(<a href>
// 点击 / location.reload() / Vite HMR 整页刷新 / 拖入 URL)时 did-start-navigation 已发生、文档却未被替换 ——
// 此时清理会误回收旧页面仍在用的资源(fs watcher / 插件身份 token / 插件 MCP 工具 / 插件子进程),且旧页面
// 收不到任何通知。页面发起的导航 details.initiator 为发起 frame;拖入 URL 无发起 frame,靠 URL 判定排除。

import type { WebContents } from 'electron';

let isReloadUrl: ((url: string) => boolean) | null = null;
let isPageReload: ((url: string, currentUrl: string) => boolean) | null = null;

/**
 * main 启动时注入「本应用 renderer 入口」判定(index.ts 的 isOwnRendererUrl)。未注入(单测)时退化为
 * 旧语义:任何主框架非同文档导航都视为 reload。
 */
export function setReloadUrlPredicate(fn: ((url: string) => boolean) | null): void {
  isReloadUrl = fn;
}

/**
 * main 启动时注入导航守卫放行的「页面自行刷新」判定(window-open-policy 的 isAllowedPageReload,dev 下同 URL 刷新)。
 * 被放行的页面发起导航会真的替换文档 → 视为 reload 回收;与守卫共用同一函数,放行 ⇔ 回收。未注入 → 页面发起的
 * 导航一律不回收。
 */
export function setPageReloadPredicate(fn: ((url: string, currentUrl: string) => boolean) | null): void {
  isPageReload = fn;
}

export function makeWcGoneHook(onGone: (wcId: number) => void): (wc: WebContents) => void {
  const attached = new WeakSet<WebContents>();
  return (wc) => {
    if (attached.has(wc)) return;
    attached.add(wc);
    const wcId = wc.id;
    wc.once('destroyed', () => onGone(wcId));
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      // 页面发起:会被导航守卫拦下(popout 首次加载时尚无资源可回收)—— 守卫放行的同 URL 刷新除外。
      if (details.initiator && !isPageReload?.(details.url, wc.getURL())) return;
      if (isReloadUrl !== null && !isReloadUrl(details.url)) return; // 外链:会被导航守卫拦下
      onGone(wcId);
    });
  };
}
