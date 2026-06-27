// topic-15 unified-toast-notification: 单条 Toast 视觉。
// **暂留 src/notifications/**;通用化后(>2 个调用源)推回 Nous shell-ui 与 src/design/。
// 不引第三方;color/token 全走 var(--md-error/warning/info/success) + currentColor,
// 不出现裸 hex / Tailwind 默认色(token-only Safeguard)。

import React from 'react';
import type { ReactNode } from 'react';
import type { Notification } from './types';
import { useT } from '@/i18n';
import './Toast.css';

export interface ToastProps {
  readonly notification: Notification;
  readonly onDismiss: (id: string) => void;
}

export function Toast({ notification, onDismiss }: ToastProps): ReactNode {
  const t = useT();
  const { id, level, message, code } = notification;
  return (
    <div
      // a11y(A60):错误 toast 须 role="alert"(assertive,语义=错误/告警),其余 role="status"
      // (polite)。此前固定 role=status 让 AT 把失败也读成普通状态消息;notify.error 是 A46-A59
      // 大量静默失败修复的可访问反馈出口,出口语义必须正确。role 与 aria-live 严重度保持一致。
      role={level === 'error' ? 'alert' : 'status'}
      aria-live={level === 'error' ? 'assertive' : 'polite'}
      data-level={level}
      className={`toast toast--${level}`}
    >
      <span className="toast__icon" aria-hidden="true" />
      <div className="toast__body">
        <span className="toast__message">{message}</span>
        {code !== undefined ? <span className="toast__code">[{code}]</span> : null}
      </div>
      <button
        type="button"
        className="toast__dismiss"
        aria-label={t('notifications.dismiss')}
        onClick={() => onDismiss(id)}
      >
        ×
      </button>
    </div>
  );
}
