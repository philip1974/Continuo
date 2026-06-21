// topic-15 unified-toast-notification: 容器层。fixed 右下,vertical stack,slice(-5)。

import React from 'react';
import type { ReactNode } from 'react';
import { useNotify } from './NotificationsProvider';
import { Toast } from './Toast';
import { useT } from '@/i18n';
import './ToastViewport.css';

const VISIBLE_LIMIT = 5;

export function ToastViewport(): ReactNode {
  const t = useT();
  const { notifications, dismiss } = useNotify();
  if (notifications.length === 0) return null;
  const visible = notifications.slice(-VISIBLE_LIMIT);
  return (
    <div className="toast-viewport" aria-label={t('notifications.viewport_label')}>
      {visible.map((n) => (
        <Toast key={n.id} notification={n} onDismiss={dismiss} />
      ))}
    </div>
  );
}
