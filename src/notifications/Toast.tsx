// topic-15 unified-toast-notification: 单条 Toast 视觉。
// **暂留 src/notifications/**;通用化后(>2 个调用源)再移入 src/design/。
// 不引第三方;color/token 全走 var(--md-error/warning/info/success) + currentColor,
// 不出现裸 hex / Tailwind 默认色(token-only Safeguard)。

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FocusEvent, ReactNode } from 'react';
import type { Notification } from './types';
import './Toast.css';

export interface ToastProps {
  readonly notification: Notification;
  readonly onDismiss: (id: string) => void;
  readonly dismissLabel: string;
  /** 悬停 / 焦点在 toast 内时暂停自动消失,离开后恢复(provider 按剩余时间续算)。 */
  readonly onPause: (id: string) => void;
  readonly onResume: (id: string) => void;
  /**
   * 是否作为 live region 播报(role=alert/status + aria-live)。同一通知可能同时渲染在主窗与 popout 子窗,
   * 只让一个副本播报,否则读屏重复读(由 ToastViewport 按通知首次出现时决定,之后不变)。
   */
  readonly announce?: boolean;
}

export function Toast({
  notification,
  onDismiss,
  dismissLabel,
  onPause,
  onResume,
  announce = true,
}: ToastProps): ReactNode {
  const { id, level, message, code, count = 1 } = notification;
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // 焦点进入 toast 前所在的元素(focusin 的 relatedTarget);toast 卸载时若焦点在其内,还给它,
  // 否则节点移除后焦点落到 body(Tab 到 × 停住,计时到 / 点 × 后键盘用户丢失位置)。
  const prevFocusRef = useRef<HTMLElement | null>(null);

  const paused = hovered || focusWithin;
  useEffect(() => {
    if (!paused) return;
    onPause(id);
    return () => onResume(id);
  }, [paused, id, onPause, onResume]);

  // layout cleanup 在 React 移除 DOM 之前执行,此时还能看到焦点仍在本节点内。
  useLayoutEffect(() => {
    const root = rootRef.current;
    return () => {
      const prev = prevFocusRef.current;
      if (!root || !prev || !prev.isConnected) return;
      if (root.contains(root.ownerDocument.activeElement)) prev.focus();
    };
  }, []);

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    setFocusWithin(true);
    const from = e.relatedTarget;
    // 跨文档(popout)节点不是本窗口的 HTMLElement 实例,按 focus 方法判断。
    if (from && !e.currentTarget.contains(from) && 'focus' in from) {
      prevFocusRef.current = from as HTMLElement;
    }
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return;
    setFocusWithin(false);
  };

  return (
    <div
      ref={rootRef}
      // a11y(A60):错误 toast 须 role="alert"(assertive,语义=错误/告警),其余 role="status"
      // (polite)。此前固定 role=status 让 AT 把失败也读成普通状态消息;notify.error 是 A46-A59
      // 大量静默失败修复的可访问反馈出口,出口语义必须正确。role 与 aria-live 严重度保持一致。
      role={announce ? (level === 'error' ? 'alert' : 'status') : undefined}
      aria-live={announce ? (level === 'error' ? 'assertive' : 'polite') : undefined}
      data-level={level}
      data-code={code}
      className={`toast toast--${level}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <span className="toast__icon" aria-hidden="true" />
      <div className="toast__body">
        {/* 错误码不进正文(用户看不懂、占地方),悬停 title 与 data-code 保留给支持排错。 */}
        <span className="toast__message" title={code !== undefined ? `${message} (${code})` : undefined}>
          {message}
        </span>
        {/* 相同内容合并后的次数(见 NotificationsProvider)。 */}
        {count > 1 ? <span className="toast__count">×{count}</span> : null}
      </div>
      {/* native button:样式由 toast.css 的 .toast__dismiss 定义(token-only),toast 暂留本目录未并入 design。 */}
      <button
        type="button"
        className="toast__dismiss"
        aria-label={dismissLabel}
        onClick={() => onDismiss(id)}
      >
        ×
      </button>
    </div>
  );
}
