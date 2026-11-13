// window.open(dockview popout 等)的目标是否是本应用自己的 renderer 入口。是 → 允许开子窗并注入 preload;
// 否 → 拒绝(http(s) / mailto 外链另行交给系统打开)。
//
// 判定必须与主窗的加载方式一致(见 index.ts createMainWindow):
//  - 有可用的 dev server URL(未打包且设了 ELECTRON_RENDERER_URL)→ 主窗 loadURL,子窗只认同源;
//  - 否则(已打包,或未打包但直接跑构建产物:预览 / e2e)→ 主窗 loadFile,子窗只认受信的 renderer 文件入口
//    (精确 pathname,不放行任意 file://,否则恶意 file:// 弹窗会被注入全量 preload)。
// 此前只按「是否打包」分支:未打包且没有 dev server 时要求同源 dev URL,而它不存在 → 所有 popout 被拒。

export function isOwnRendererWindowUrl(
  url: string,
  devRendererUrl: URL | null,
  isTrustedRendererFile: (url: string) => boolean,
): boolean {
  if (devRendererUrl === null) return isTrustedRendererFile(url);
  try {
    return new URL(url).origin === devRendererUrl.origin;
  } catch {
    return false;
  }
}
