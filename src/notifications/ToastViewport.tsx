// topic-15 unified-toast-notification: 容器层。fixed 右下,vertical stack,slice(-5)。

import React from 'react';
import type { ReactNode } from 'react';
import { useNotify } from './NotificationsProvider';
import { Toast } from './Toast';
import { useT } from '@/i18n';
import './ToastViewport.css';

const VISIBLE_LIMIT = 5;

export function selectVisibleNotifications<T>(
  notifications: readonly T[],
): readonly T[] {
  if (notifications.length <= VISIBLE_LIMIT) return notifications;
  const start = Math.max(0, notifications.length - VISIBLE_LIMIT);
  const visible = new Array<T>(notifications.length - start);
  let visibleCount = 0;
  for (let i = start; i < notifications.length; i++) {
    visible[visibleCount] = notifications[i]!;
    visibleCount += 1;
  }
  return visible;
}

export function ToastViewport(): ReactNode {
  const t = useT();
  const { notifications, dismiss } = useNotify();
  if (notifications.length === 0) return null;
  const visible = selectVisibleNotifications(notifications);
  return (
    <div
      // a11y(A113 同族):aria-label 须挂有语义 role 才能形成可导航区域 → role="region"
      // 让 toast 容器成为命名「通知」landmark/region,SR 可按区域回看通知栈(此前 label 挂
      // 无 role div 无效)。
      role="region"
      className="toast-viewport"
      aria-label={t('notifications.viewport_label')}
    >
      {visible.map((n) => (
        <Toast key={n.id} notification={n} onDismiss={dismiss} />
      ))}
    </div>
  );
}
