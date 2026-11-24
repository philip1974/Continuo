// topic-15 unified-toast-notification: 容器层。fixed 右下,vertical stack;同时只显示最早的 MAX_VISIBLE_NOTIFICATIONS 条,
// 其余排队(计时也只给可见的,见 NotificationsProvider)。
// 主窗之外,还经 createPortal 渲染进每个 dockview popout 子窗(弹出面板的 notify.* 全进主窗 provider,
// 子窗只能这样看到)。toast 本身不是 live region;读屏播报写进常驻、视觉隐藏的 polite / assertive live region
// (ToastAnnouncers,每个文档一份),每次播报只写进一个文档,避免重复播报。

import { useRef, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MAX_VISIBLE_NOTIFICATIONS, useNotify } from './NotificationsProvider';
import type { ToastAnnouncement } from './NotificationsProvider';
import { Toast } from './Toast';
import type { Notification } from './types';
import { useT } from '@/i18n';
import { SR_ONLY_STYLE } from '@/lib/sr-only';
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
  const { notifications, announcement, dismiss, pause, resume } = useNotify();
  const popoutDocs = useSyncExternalStore(
    subscribePopoutDocuments,
    getPopoutDocuments,
  );
  return (
    <>
      <ToastAnnouncers announcement={announcement} popoutDocs={popoutDocs} />
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

/** 有焦点的 popout 子窗优先(用户正在看那一屏),否则主窗。 */
function pickAnnouncingDocument(popoutDocs: readonly Document[]): Document {
  for (const doc of popoutDocs) if (doc.hasFocus()) return doc;
  return document;
}

/**
 * 常驻的播报 live region:每个文档(主窗 + 每个 popout 子窗)各一对 polite / assertive,无通知时也在(live region
 * 须先于内容存在,读屏才会播报插入的文本)。每次播报只写进一个文档 —— 播报首次渲染时有焦点的 popout 子窗,否则主窗 ——
 * 之后不变(与 toast 副本「只一份 live region」同一规则,读屏不重复)。
 */
function ToastAnnouncers({
  announcement,
  popoutDocs,
}: {
  readonly announcement: ToastAnnouncement | null;
  readonly popoutDocs: readonly Document[];
}): ReactNode {
  const targetRef = useRef<{ seq: number; doc: Document } | null>(null);
  if (announcement !== null && targetRef.current?.seq !== announcement.seq) {
    targetRef.current = { seq: announcement.seq, doc: pickAnnouncingDocument(popoutDocs) };
  }
  const target = targetRef.current?.doc;
  const regionsFor = (doc: Document) => (
    <LiveRegions announcement={target === doc ? announcement : null} />
  );
  return (
    <>
      {regionsFor(document)}
      {popoutDocs.map((doc) => createPortal(regionsFor(doc), doc.body, portalKeyOf(doc)))}
    </>
  );
}

function LiveRegions({ announcement }: { readonly announcement: ToastAnnouncement | null }): ReactNode {
  // 每次播报用 seq 作 key 换新节点:同样的文本再次出现也是一次插入,读屏会再读。
  const spoken = (politeness: ToastAnnouncement['politeness']) =>
    announcement?.politeness === politeness ? <span key={announcement.seq}>{announcement.text}</span> : null;
  return (
    <>
      <div data-toast-announcer="" aria-live="polite" aria-atomic="true" style={SR_ONLY_STYLE}>
        {spoken('polite')}
      </div>
      <div data-toast-announcer="" aria-live="assertive" aria-atomic="true" style={SR_ONLY_STYLE}>
        {spoken('assertive')}
      </div>
    </>
  );
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
