// renderer 端 breadcrumb 入口(issue #33)。
// 包装 coApi.diagnostics.breadcrumb,失败静默(诊断不可挂主流程)。
// 自动附带 windowSeq + side='renderer'。

import { coApi } from '../co-api';
import { parseInitialWindowSeq } from '../initial-workspace';

let _cachedWindowSeq: number | null = null;

function getWindowSeq(): number {
  if (_cachedWindowSeq !== null) return _cachedWindowSeq;
  const search = typeof window !== 'undefined' ? window.location.search : '';
  _cachedWindowSeq = parseInitialWindowSeq(search);
  return _cachedWindowSeq;
}

/** 写一条 breadcrumb;失败静默. */
export function breadcrumb(entry: { event: string; [k: string]: unknown }): void {
  void (async () => {
    try {
      await coApi.diagnostics.breadcrumb({
        side: 'renderer',
        windowSeq: getWindowSeq(),
        ...entry,
      });
    } catch {
      /* coApi 未就绪 / IPC 失败 — 诊断不抛 */
    }
  })();
}

/** 探针:Tailwind 是否真的把 bg-canvas / text-fg 这种语义 token 解析了. */
export function probeCssLoaded(): boolean {
  if (typeof document === 'undefined') return false;
  const probe = document.createElement('div');
  probe.className = 'bg-canvas';
  probe.style.position = 'absolute';
  probe.style.left = '-9999px';
  document.body.appendChild(probe);
  const bg = getComputedStyle(probe).backgroundColor;
  document.body.removeChild(probe);
  // CSS 未加载 → 默认 rgba(0,0,0,0) / transparent。加载后是非透明值。
  return bg !== '' && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
}
