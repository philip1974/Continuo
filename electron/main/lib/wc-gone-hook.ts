// 「该 webContents 名下的 main 侧资源该清了」的统一钩子(plugin-mcp 的工具 stub 与 plugin-shell-stream
// 的在途子进程此前各手写一份,后者注释自称「镜像」前者)。两种时机都要清:
//   - destroyed:窗口 / webContents 销毁;
//   - did-start-navigation(main frame 且非同文档):renderer reload(Ctrl+R / HMR full reload /
//     webContents.reload())—— webContents 不销毁、id 不变,但 renderer 侧状态被整体撕掉重建,不会有任何
//     「我要走了」的通知。须在新文档脚本执行前清掉残留;hash / pushState(同文档)不算。
// 每个 webContents 只挂一次(按对象身份记,反复 reload 复用同一持久监听)。回调须幂等。

import type { WebContents } from 'electron';

export function makeWcGoneHook(onGone: (wcId: number) => void): (wc: WebContents) => void {
  const attached = new WeakSet<WebContents>();
  return (wc) => {
    // 单测里的假 webContents 可能不带 once / on,缺则跳过对应监听。
    if (attached.has(wc) || typeof wc.once !== 'function') return;
    attached.add(wc);
    const wcId = wc.id;
    wc.once('destroyed', () => onGone(wcId));
    if (typeof wc.on === 'function') {
      wc.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) onGone(wcId);
      });
    }
  };
}
