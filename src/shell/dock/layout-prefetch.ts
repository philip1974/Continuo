// 性能(冷启动关键路径):dock 布局读取预取。
//
// DockShell 原先在 React 首次提交 + dockview onReady 之后才发 layout.read();main 端要读 + 解析 + Zod
// 校验整份 explorer.json,这段 IPC 往返落在 Splash 放行的关键路径上。renderer init() 开头即调
// prefetchDockLayout() 并发发起,DockShell 首次 onReady 经 readDockLayout() 消费一次;之后的 onReady
//(StrictMode / dockview 重建 / HMR 重挂)预取已被取走 → 照旧重新读取,不复用旧结果。
//
// 预取结果在首次 onReady 时仍有效:窗口段的 layout 是 main-owned 字段,只有本窗口 DockShell 的
// layout:write 会改它(explorer:write 合并时保留 cur.layout,别窗只写自己 windowSeq 段),而 DockShell
// 在布局恢复(首次 onReady 消费预取之后)才注册写入。layout:read 不带参数,windowSeq 由 main 按 sender
// 解析(窗口创建时即 setWindowSeq,早于页面加载),读端守卫 sanitizeReadLayout 在 main 侧对每次读取同样生效。

import { coApi } from '@/lib/co-api';

type LayoutReadResult = Awaited<ReturnType<typeof coApi.layout.read>>;

let prefetched: Promise<LayoutReadResult> | null = null;

// 同步抛错(桥缺失等)统一转成 rejected promise:调用方 `await` 在 try 内,与原先
// `await coApi.layout.read()` 的失败处理(restoreFailed → 默认布局 + 提示)一致。
function invokeRead(): Promise<LayoutReadResult> {
  try {
    // Promise.resolve:非 promise 返回值(桩 / 异常桥)与原先 `await coApi.layout.read()` 同样交给调用方处理。
    return Promise.resolve(coApi.layout.read());
  } catch (err) {
    return Promise.reject(err);
  }
}

/** renderer 启动最早处调用:并发发起 layout.read,结果留给 DockShell 首次 onReady。 */
export function prefetchDockLayout(): void {
  const p = invokeRead();
  // 消费前 reject 不应成为 unhandled rejection;消费方 await 同一 promise 仍会拿到 reject。
  p.catch(() => {});
  prefetched = p;
}

/** 取走预取结果(仅一次);无预取则发起新的 layout.read。 */
export function readDockLayout(): Promise<LayoutReadResult> {
  const p = prefetched;
  prefetched = null;
  return p ?? invokeRead();
}
