// topic-15 unified-toast-notification: Provider + Context + queue + auto-dismiss + dedupe + epoch guard.
// 灵感来自 Nous shell-cli/ink/notifications/NotificationsProvider.tsx;DOM 端适配 + 差异化策略。

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type { Notification, NotificationLevel } from './types';
import { __registerHandle } from './notify';
import type { NotifyApi, NotifyOpts } from './notify';
import { filterKeepingIdentity } from '@/lib/filter-keeping-identity';

// ─── auto-dismiss 配置 ─────────────────────
const DISMISS_MS: Record<NotificationLevel, number> = {
  info: 5000,
  warning: 5000,
  success: 5000,
  error: 15000,
};
const DEDUPE_WINDOW_MS = 1000;
// 审计 P2-C:底层数组硬上限。error 级不参与 dedupe 且存活 15s,15s 内的 error
// 突发(批量安装失败 / 循环 IPC 报错)会在 state 里无界堆积。显示层只 slice 可见区,
// 不限制底层数组本身,故在 push 时按上限丢最旧(并清其 timer)。
export const MAX_NOTIFICATIONS = 50;
const EMPTY_NOTIFICATIONS: readonly Notification[] = [];

function appendCappedNotification(
  prev: readonly Notification[],
  notification: Notification,
  onDrop: (notification: Notification) => void,
): readonly Notification[] {
  const dropCount = Math.max(0, prev.length + 1 - MAX_NOTIFICATIONS);
  if (dropCount > 0) {
    for (let i = 0; i < dropCount; i++) {
      const dropped = prev[i];
      if (dropped !== undefined) onDrop(dropped);
    }
  }

  const keptCount = prev.length - dropCount;
  const next = new Array<Notification>(keptCount + 1);
  let nextCount = 0;
  for (let i = dropCount; i < prev.length; i++) {
    next[nextCount] = prev[i]!;
    nextCount += 1;
  }
  next[nextCount] = notification;
  return next;
}

function removeNotificationById(
  notifications: readonly Notification[],
  id: string,
): readonly Notification[] {
  return filterKeepingIdentity<Notification, readonly Notification[]>(
    notifications,
    (notification) => notification.id !== id,
    EMPTY_NOTIFICATIONS,
  );
}

function updateNotificationCreatedAt(
  notifications: readonly Notification[],
  id: string,
  createdAt: number,
): readonly Notification[] {
  let next: Notification[] | null = null;
  let nextCount = 0;
  for (let i = 0; i < notifications.length; i++) {
    const notification = notifications[i]!;
    let current = notification;
    if (notification.id === id) {
      if (notification.createdAt === createdAt) return notifications;
      if (next === null) {
        next = new Array<Notification>(notifications.length);
        for (let j = 0; j < i; j++) {
          next[j] = notifications[j]!;
        }
        nextCount = i;
      }
      current = { ...notification, createdAt };
    }
    if (next !== null) {
      next[nextCount] = current;
      nextCount += 1;
    }
  }
  return next ?? notifications;
}

interface NotificationsContextValue {
  readonly notifications: readonly Notification[];
  readonly dismiss: (id: string) => void;
  /** 悬停 / 焦点进入 toast 时暂停自动消失(可重入计数,每次 pause 配一次 resume)。 */
  readonly pause: (id: string) => void;
  /** 与 pause 成对;计数归零后按暂停时的剩余时间续算。 */
  readonly resume: (id: string) => void;
}

// 自动消失计时:暂停时记下剩余时间,恢复时续算(悬停读长报错不会读到一半消失)。
interface DismissTimer {
  handle: ReturnType<typeof setTimeout> | null;
  dueAt: number;
  remaining: number;
  pauses: number;
}

const noop = (): void => {
  /* noop */
};

const NotificationsContext =
  createContext<NotificationsContextValue>({
    notifications: EMPTY_NOTIFICATIONS,
    dismiss: noop,
    pause: noop,
    resume: noop,
  });

// ─── epoch race 防护 ──────────────────────
let moduleEpoch = 0;

export interface NotificationsProviderProps {
  readonly children: ReactNode;
}

export function NotificationsProvider({
  children,
}: NotificationsProviderProps): ReactNode {
  const [notifications, setNotifications] = useState<readonly Notification[]>(
    EMPTY_NOTIFICATIONS,
  );
  const notificationsRef = useRef<readonly Notification[]>(EMPTY_NOTIFICATIONS);
  const counterRef = useRef(0);
  const timersRef = useRef(new Map<string, DismissTimer>());

  const setNotificationList = useCallback(
    (update: (prev: readonly Notification[]) => readonly Notification[]) => {
      setNotifications((prev) => {
        const resolved = update(prev);
        notificationsRef.current = resolved;
        return resolved;
      });
    },
    [],
  );

  const clearDismissTimer = useCallback((id: string) => {
    const t = timersRef.current.get(id);
    if (t !== undefined) {
      if (t.handle !== null) clearTimeout(t.handle);
      timersRef.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      clearDismissTimer(id);
      // race(R104,R13 对偶):同步从 notificationsRef 移除,使同一 tick 内后续 notify 的 dedupe
      // 不再看到已关闭通知。否则 dismiss() 只在 setNotificationList 的 updater(延迟到 render)里更新
      // ref —— 同 tick 紧接的同源 non-error notify 会从旧 ref 匹配到这条「已关闭」通知走 dedupe 分支:
      // 既不新增也不复活(其 map updater 在 dismiss 的 filter updater 之后跑,existing.id 已不在 prev
      // → no-op),新通知被静默吞掉;还给已删 id 重挂 auto-dismiss timer。下面 functional updater 仍
      // 是权威(落 ref);此处同步值仅为同 tick 先行可见,与 R13 notify 侧同步写 ref 对称。
      notificationsRef.current = removeNotificationById(
        notificationsRef.current,
        id,
      );
      setNotificationList((prev) => removeNotificationById(prev, id));
    },
    [clearDismissTimer, setNotificationList],
  );

  const startDismissTimer = useCallback(
    (id: string, timer: DismissTimer) => {
      timer.dueAt = Date.now() + timer.remaining;
      timer.handle = setTimeout(() => {
        timersRef.current.delete(id);
        notificationsRef.current = removeNotificationById(
          notificationsRef.current,
          id,
        );
        setNotificationList((prev) => removeNotificationById(prev, id));
      }, timer.remaining);
    },
    [setNotificationList],
  );

  const scheduleDismiss = useCallback(
    (id: string, level: NotificationLevel) => {
      const existing = timersRef.current.get(id);
      if (existing?.handle != null) clearTimeout(existing.handle);
      const timer: DismissTimer = existing ?? { handle: null, dueAt: 0, remaining: 0, pauses: 0 };
      timer.handle = null;
      timer.remaining = DISMISS_MS[level];
      timersRef.current.set(id, timer);
      // 暂停中(悬停 / 焦点在内)只刷新余量,等 resume 再起计时。
      if (timer.pauses === 0) startDismissTimer(id, timer);
    },
    [startDismissTimer],
  );

  const pause = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer === undefined) return;
    timer.pauses += 1;
    if (timer.handle === null) return;
    clearTimeout(timer.handle);
    timer.handle = null;
    timer.remaining = Math.max(0, timer.dueAt - Date.now());
  }, []);

  const resume = useCallback(
    (id: string) => {
      const timer = timersRef.current.get(id);
      if (timer === undefined || timer.pauses === 0) return;
      timer.pauses -= 1;
      if (timer.pauses === 0 && timer.handle === null) startDismissTimer(id, timer);
    },
    [startDismissTimer],
  );

  const notify = useCallback(
    (
      message: string,
      level: NotificationLevel,
      opts?: NotifyOpts,
    ) => {
      const now = Date.now();
      const code = opts?.code;

      if (level !== 'error') {
        let existing: Notification | undefined;
        for (let i = notificationsRef.current.length - 1; i >= 0; i--) {
          const n: Notification | undefined = notificationsRef.current[i];
          if (
            n !== undefined &&
            n.level === level &&
            n.message === message &&
            (n.code ?? null) === (code ?? null) &&
            now - n.createdAt < DEDUPE_WINDOW_MS
          ) {
            existing = n;
            break;
          }
        }
        if (existing) {
          notificationsRef.current = updateNotificationCreatedAt(
            notificationsRef.current,
            existing.id,
            now,
          );
          setNotificationList((prev) =>
            updateNotificationCreatedAt(
              prev,
              existing.id,
              now,
            ),
          );
          scheduleDismiss(existing.id, level);
          return;
        }
      }

      const id = `notif-${String(++counterRef.current)}`;
      const n: Notification = { id, level, message, code, createdAt: now };
      // race(R13):同步把新通知写入 notificationsRef,使同一事件循环内后续 notify 的去重能看到
      // 这条 pending 通知。ref 原本只在 setNotifications 的 updater 执行时(延迟到 render)才更新
      // → 同 tick 连续两次同源 notify 第二次读到的 ref 仍缺第一条 → 各自入队绕过去重。下面的
      // functional updater 仍是权威(基于 React prev 计算 + trim 后落 ref);此处同步值仅为同 tick
      // 先行可见(updater 落 ref 后即收敛,trim 差异在 tick 内对去重无害——只是多几条可匹配项)。
      const onDrop = (dropped: Notification) => clearDismissTimer(dropped.id);
      notificationsRef.current = appendCappedNotification(
        notificationsRef.current,
        n,
        onDrop,
      );
      setNotificationList((prev) => appendCappedNotification(prev, n, onDrop));
      scheduleDismiss(id, level);
    },
    [clearDismissTimer, scheduleDismiss, setNotificationList],
  );

  // epoch race 防护:mount 时注册,unmount 时仅当自身 epoch === 当前 currentEpoch 才清空
  useEffect(() => {
    const myEpoch = ++moduleEpoch;
    const api: NotifyApi = { notify };
    __registerHandle(api, myEpoch);
    return () => {
      // 仅在自身仍是当前 epoch 时清空(防 StrictMode 双 mount / HMR 旧实例 unmount 清新单例)
      __registerHandle(null, myEpoch);
    };
  }, [notify]);

  // unmount 清所有 timer
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) {
        if (t.handle !== null) clearTimeout(t.handle);
      }
      timers.clear();
    };
  }, []);

  const value = useMemo<NotificationsContextValue>(
    () => ({ notifications, dismiss, pause, resume }),
    [notifications, dismiss, pause, resume],
  );

  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  );
}

export function useNotify(): NotificationsContextValue {
  return useContext(NotificationsContext);
}

