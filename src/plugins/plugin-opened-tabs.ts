// 安全:插件经 editor.openFile 打开的标签,主进程为每一份 plugin-fs:read-for-editor 记一条「插件打开的路径」
//(宿主对它的读 / 写先确认路径没被换入链接),记录数有上限且不淘汰。这里把记录的生命周期绑到标签上:
// - 用这份内容新建了标签 → 由标签(pluginOpenedPath 标记)持有,标签以任何方式消失(关闭 / 删除文件 / 切 root /
//   整体重置)时释放;
// - 没有新建标签(已开着只切换 / 打开失败 / 插件已吊销)→ 调用方当即 releasePluginOpenedPath。
// 不释放会让记录只增不减:满额后插件的 openFile 永久失败。窗口关闭 / renderer 重载由主进程整窗释放。
import { coApi } from '@/lib/co-api';
import { useEditorStore, type EditorTab } from '@/stores/editor.store';

/** 释放主进程的一份记录。best-effort:失败只告警(最坏是记录多占一个名额,直到窗口关闭)。 */
export function releasePluginOpenedPath(path: string): void {
  void Promise.resolve()
    .then(() => coApi.pluginFsRaw.releaseEditorPath(path))
    .catch((err: unknown) => console.warn('[editor] release plugin-opened path failed', err));
}

let held = new Map<string, number>();
let started = false;

function countMarked(tabs: readonly EditorTab[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const tab of tabs) {
    const p = tab.pluginOpenedPath;
    if (p !== undefined) out.set(p, (out.get(p) ?? 0) + 1);
  }
  return out;
}

function reconcile(tabs: readonly EditorTab[]): void {
  const now = countMarked(tabs);
  for (const [path, before] of held) {
    for (let n = now.get(path) ?? 0; n < before; n++) releasePluginOpenedPath(path);
  }
  held = now;
}

/** 幂等:开始跟踪带 pluginOpenedPath 标记的标签,消失即释放。由首次 openVerifiedFile 启动。 */
export function ensurePluginOpenedTabTracking(): void {
  if (started) return;
  started = true;
  held = countMarked(useEditorStore.getState().tabs);
  useEditorStore.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs && (s.chromeVersion !== prev.chromeVersion || s.tabs.length !== prev.tabs.length)) {
      reconcile(s.tabs);
    }
  });
}
