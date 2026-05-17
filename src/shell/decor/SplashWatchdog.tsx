// 启动/刷新黑屏看门狗(issue #33)。
//
// 行为契约见 `src/__tests__/splash-watchdog/README.md`。
//
// 关键防御:外层 wrapper 用 inline style 强制可见 — CSS 没加载时 Tailwind
// 的 bg-canvas / text-fg 都不生效,内部 design Modal 仍可被看到。
// 字体颜色用 inline 白色保底,而非 bg-clip-text 的渐变(那玩意儿没 CSS 就是透明)。

import { useEffect, useRef, useState } from 'react';
import { Modal } from '@/design/Modal';
import { Button } from '@/design/Button';
import { coApi } from '@/lib/co-api';
import { breadcrumb } from '@/lib/diagnostics/breadcrumb';

export interface SplashSnapshot {
  readonly layoutReady: boolean;
  readonly workspaceRoot: string | null;
  readonly sidebarOpen: boolean;
  readonly hasCoApi: boolean;
  readonly cssLoaded: boolean;
}

export interface SplashWatchdogProps {
  /** App 的 layoutReady state. true → watchdog 永远不触发. */
  readonly layoutReady: boolean;
  /** "强制进入应用" 按钮回调:让 App 把 layoutReady 翻 true. */
  readonly forceEnter: () => void;
  /** Watchdog 触发时调一次,写入 breadcrumb 的快照. */
  readonly snapshot: () => SplashSnapshot;
  /** Deadline 毫秒(默认 3000). */
  readonly deadlineMs?: number;
}

export function SplashWatchdog({
  layoutReady,
  forceEnter,
  snapshot,
  deadlineMs = 3000,
}: SplashWatchdogProps) {
  const [timedOut, setTimedOut] = useState(false);
  const snapshotRef = useRef<SplashSnapshot | null>(null);

  useEffect(() => {
    if (layoutReady) return;
    const t = setTimeout(() => {
      const snap = snapshot();
      snapshotRef.current = snap;
      breadcrumb({ event: 'splash_timeout', ...snap });
      setTimedOut(true);
    }, deadlineMs);
    return () => clearTimeout(t);
  }, [layoutReady, deadlineMs, snapshot]);

  if (!timedOut) return null;
  const snap = snapshotRef.current ?? snapshot();

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        color: '#fff',
        background: 'rgba(2, 6, 23, 0.95)',
      }}
    >
      <Modal visible={true} size="md">
        <div
          style={{ color: '#fff', padding: '8px 4px' }}
          aria-live="assertive"
        >
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
            启动卡屏诊断
          </h2>
          <p style={{ fontSize: 13, marginBottom: 12, opacity: 0.8 }}>
            应用启动超过 {Math.round(deadlineMs / 1000)} 秒仍未就绪。下方是
            当前状态快照,已写入日志。
          </p>
          <pre
            style={{
              fontSize: 12,
              background: 'rgba(0,0,0,0.4)',
              padding: 12,
              borderRadius: 6,
              marginBottom: 16,
              overflow: 'auto',
              maxHeight: 200,
            }}
          >
            {JSON.stringify(snap, null, 2)}
          </pre>
          <div
            style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}
          >
            <Button
              variant="secondary"
              onClick={() => {
                void coApi.shell.openLogsDir().catch(() => undefined);
              }}
            >
              打开日志目录
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                void coApi.app.relaunch().catch(() => undefined);
              }}
            >
              重新启动
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                forceEnter();
                setTimedOut(false);
              }}
            >
              强制进入应用
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
