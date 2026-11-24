// topic-15 unified-toast-notification: 容器层。fixed 右下,vertical stack;同时只显示最早的 MAX_VISIBLE_NOTIFICATIONS 条,
// 其余排队(计时也只给可见的,见 NotificationsProvider)。
// 主窗之外,还经 createPortal 渲染进每个 dockview popout 子窗(弹出面板的 notify.* 全进主窗 provider,
// 子窗只能这样看到)。同一通知只让一个文档的副本作 live region,避免读屏重复播报。

import { useRef, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MAX_VISIBLE_NOTIFICATIONS, useNotify } from './NotificationsProvider';
import { Toast } from './Toast';
import type { Notification } from './types';
import { useT } from '@/i18n';
import {
  getPopoutDocuments,
  subscribePopoutDocuments,
} from '@/shell/dock/popout-documents';
import './ToastViewport.css';

/** 可见区 = 列表前 MAX_VISIBLE_NOTIFICATIONS 条(最早的先显示,其余排队);未超上限时复用原数组。 */
export function selectVisibleNotifications<T>(
  notifications: readonly T[],
): readonly T[] {
  if (notifications.length <= MAX_VISIBLE_NOTIFICATIONS) return notifications;
  const visible = new Array<T>(MAX_VISIBLE_NOTIFICATIONS);
  for (let i = 0; i < MAX_VISIBLE_NOTIFICATIONS; i++) visible[i] = notifications[i]!;
  return visible;
}

export function ToastViewport(): ReactNode {
  const { notifications, dismiss, pause, resume } = useNotify();
  const popoutDocs = useSyncExternalStore(
    subscribePopoutDocuments,
    getPopoutDocuments,
  );
  if (notifications.length === 0) return null;
  return (
    <ToastViewportWindows
      notifications={notifications}
      dismiss={dismiss}
      pause={pause}
      resume={resume}
      popoutDocs={popoutDocs}
    />
  );
}

interface ToastViewportContentProps {
  readonly notifications: readonly Notification[];
  readonly dismiss: (id: string) => void;
  readonly pause: (id: string) => void;
  readonly resume: (id: string) => void;
  /** 该文档的副本是否作 live region 播报此通知。 */
  readonly announces: (id: string) => boolean;
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

/** 有焦点的 popout 子窗优先(用户正在看那一屏),否则主窗。 */
function pickAnnouncingDocument(popoutDocs: readonly Document[]): Document {
  for (const doc of popoutDocs) if (doc.hasFocus()) return doc;
  return document;
}

function ToastViewportWindows({
  popoutDocs,
  ...props
}: Omit<ToastViewportContentProps, 'announces'> & {
  readonly popoutDocs: readonly Document[];
}): ReactNode {
  // 每条通知的播报文档在其首次渲染时决定且之后不变:事后改 role / aria-live 会让读屏把已有内容再读一遍。
  const announcerRef = useRef(new Map<string, Document>());
  const announcer = announcerRef.current;
  const ids = new Set<string>();
  for (const n of props.notifications) {
    ids.add(n.id);
    if (!announcer.has(n.id)) announcer.set(n.id, pickAnnouncingDocument(popoutDocs));
  }
  for (const id of announcer.keys()) if (!ids.has(id)) announcer.delete(id);
  const announcesIn = (doc: Document) => (id: string) => announcer.get(id) === doc;
  return (
    <>
      <ToastViewportContent {...props} announces={announcesIn(document)} />
      {popoutDocs.map((doc) =>
        createPortal(
          <ToastViewportContent {...props} announces={announcesIn(doc)} />,
          doc.body,
          portalKeyOf(doc),
        ),
      )}
    </>
  );
}

function ToastViewportContent({
  notifications,
  dismiss,
  pause,
  resume,
  announces,
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
          announce={announces(n.id)}
          dismissLabel={dismissLabel}
        />
      ))}
    </div>
  );
}
