// topic-15 unified-toast-notification: 容器层。fixed 右下,vertical stack;同时只显示最新的 MAX_VISIBLE_NOTIFICATIONS 条
//(VSCode notificationsToasts 同),更早的隐藏(计时照常,见 NotificationsProvider)。
// 主窗之外,还经 createPortal 渲染进每个 dockview popout 子窗(弹出面板的 notify.* 全进主窗 provider,
// 子窗只能这样看到)。toast 本身不是 live region;读屏播报由 NotificationsProvider 写进全局播报区(src/lib/announce),
// 此处只为主窗与每个 popout 子窗预先建好那一对常驻 live region。

import { useEffect, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MAX_VISIBLE_NOTIFICATIONS, useNotify } from './NotificationsProvider';
import { Toast } from './Toast';
import type { Notification } from './types';
import { useT } from '@/i18n';
import { prepareAnnouncer } from '@/lib/announce';
import {
  getPopoutDocuments,
  subscribePopoutDocuments,
} from '@/shell/dock/popout-documents';
import './ToastViewport.css';

/** 可见区 = 列表末尾 MAX_VISIBLE_NOTIFICATIONS 条(最新的,保持列表顺序);未超上限时复用原数组。 */
export function selectVisibleNotifications<T>(
  notifications: readonly T[],
): readonly T[] {
  if (notifications.length <= MAX_VISIBLE_NOTIFICATIONS) return notifications;
  const start = notifications.length - MAX_VISIBLE_NOTIFICATIONS;
  const visible = new Array<T>(MAX_VISIBLE_NOTIFICATIONS);
  for (let i = 0; i < MAX_VISIBLE_NOTIFICATIONS; i++) visible[i] = notifications[start + i]!;
  return visible;
}

export function ToastViewport(): ReactNode {
  const { notifications, dismiss, pause, resume } = useNotify();
  const popoutDocs = useSyncExternalStore(
    subscribePopoutDocuments,
    getPopoutDocuments,
  );
  // live region 须先于内容存在,读屏才会播报插入的文本 → 主窗与每个 popout 子窗无通知时也预先建好。
  useEffect(() => {
    prepareAnnouncer(document);
    for (const doc of popoutDocs) prepareAnnouncer(doc);
  }, [popoutDocs]);
  return (
    <>
      {notifications.length === 0 ? null : (
        <ToastViewportWindows
          notifications={notifications}
          dismiss={dismiss}
          pause={pause}
          resume={resume}
          popoutDocs={popoutDocs}
        />
      )}
    </>
  );
}

interface ToastViewportContentProps {
  readonly notifications: readonly Notification[];
  readonly dismiss: (id: string) => void;
  readonly pause: (id: string) => void;
  readonly resume: (id: string) => void;
}

// portal key 须按文档稳定:用数组下标时收回前面的 popout,后一个子窗的 key 会变 → React 卸载重挂该窗全部 toast
// (悬停 / 焦点丢失、live region 重插可能重读)。
const portalKeys = new WeakMap<Document, string>();
let nextPortalKey = 0;
function portalKeyOf(doc: Document): string {
  let key = portalKeys.get(doc);
  if (key === undefined) {
    nextPortalKey += 1;
    key = `popout-${String(nextPortalKey)}`;
    portalKeys.set(doc, key);
  }
  return key;
}

function ToastViewportWindows({
  popoutDocs,
  ...props
}: ToastViewportContentProps & {
  readonly popoutDocs: readonly Document[];
}): ReactNode {
  return (
    <>
      <ToastViewportContent {...props} />
      {popoutDocs.map((doc) =>
        createPortal(<ToastViewportContent {...props} />, doc.body, portalKeyOf(doc)),
      )}
    </>
  );
}

function ToastViewportContent({
  notifications,
  dismiss,
  pause,
  resume,
}: ToastViewportContentProps): ReactNode {
  const t = useT();
  const visible = selectVisibleNotifications(notifications);
  const dismissLabel = t('notifications.dismiss');
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
        <Toast
          key={n.id}
          notification={n}
          onDismiss={dismiss}
          onPause={pause}
          onResume={resume}
          dismissLabel={dismissLabel}
        />
      ))}
    </div>
  );
}
