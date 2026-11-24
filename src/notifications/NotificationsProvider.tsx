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
import { hasOpenModal, subscribeOpenModals } from '@/design';

// ─── auto-dismiss 配置 ─────────────────────
const DISMISS_MS: Record<NotificationLevel, number> = {
  info: 5000,
  warning: 5000,
  success: 5000,
  error: 15000,
};
// 审计 P2-C:底层数组硬上限。内容各不相同的突发(批量安装失败 / 循环 IPC 报错)会在 state 里无界堆积
//(显示层只取可见区),故在 push 时按上限丢最旧(并清其 timer)。
export const MAX_NOTIFICATIONS = 50;
/**
 * 同时可见的 toast 上限(VSCode 通知 toast 同为 3):列表前这么多条可见,其余排队。只有可见的挂自动消失计时 ——
 * 排队中的不计时(否则在用户看到前就过期),前面的消失后依次补上并从那时开始计时。ToastViewport 按同一常量取可见区。
 */
export const MAX_VISIBLE_NOTIFICATIONS = 3;
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

/** 合并一次相同内容的通知:计数 +1、createdAt 刷新为本次(位置不变)。 */
function mergeRepeatedNotification(
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
      if (next === null) {
        next = new Array<Notification>(notifications.length);
        for (let j = 0; j < i; j++) {
          next[j] = notifications[j]!;
        }
        nextCount = i;
      }
      current = { ...notification, createdAt, count: (notification.count ?? 1) + 1 };
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
  // 有打开的模态时为 true:toast 层在模态遮罩之下(看不到、无法悬停),每个计时多计一次暂停,全部模态关闭后续算。
  const modalPausedRef = useRef(false);
  // 到期移除后补位(armVisibleTimers);经 ref 调用,避免计时回调与补位互相依赖。
  const promoteRef = useRef<() => void>(noop);

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
      promoteRef.current();
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
        promoteRef.current();
      }, timer.remaining);
    },
    [setNotificationList],
  );

  const scheduleDismiss = useCallback(
    (id: string, level: NotificationLevel) => {
      const existing = timersRef.current.get(id);
      if (existing?.handle != null) clearTimeout(existing.handle);
      // 新计时在模态打开期间创建 → 带上模态那一次暂停(模态关闭时与已有计时一同 resume)。
      const timer: DismissTimer = existing ?? {
        handle: null,
        dueAt: 0,
        remaining: 0,
        pauses: modalPausedRef.current ? 1 : 0,
      };
      timer.handle = null;
      timer.remaining = DISMISS_MS[level];
      timersRef.current.set(id, timer);
      // 暂停中(悬停 / 焦点在内)只刷新余量,等 resume 再起计时。
      if (timer.pauses === 0) startDismissTimer(id, timer);
    },
    [startDismissTimer],
  );

  // 可见区(列表前 MAX_VISIBLE_NOTIFICATIONS 条)里还没计时的(新入列 / 刚从排队补上)开始计时。读同步的 ref。
  const armVisibleTimers = useCallback(() => {
    const list = notificationsRef.current;
    const visible = Math.min(list.length, MAX_VISIBLE_NOTIFICATIONS);
    for (let i = 0; i < visible; i++) {
      const n = list[i]!;
      if (!timersRef.current.has(n.id)) scheduleDismiss(n.id, n.level);
    }
  }, [scheduleDismiss]);
  useEffect(() => {
    promoteRef.current = armVisibleTimers;
  }, [armVisibleTimers]);

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

  // 模态打开 / 全部关闭:给每个现存计时各 pause / resume 一次(与悬停 / 焦点暂停共用计数)。任一文档(主窗或 popout 子窗)
  // 有模态即暂停:toast 在每个窗口都有副本,不按窗口区分,规则简单一致。
  useEffect(() => {
    const sync = (): void => {
      const open = hasOpenModal();
      if (open === modalPausedRef.current) return;
      modalPausedRef.current = open;
      for (const id of [...timersRef.current.keys()]) {
        if (open) pause(id);
        else resume(id);
      }
    };
    sync();
    return subscribeOpenModals(sync);
  }, [pause, resume]);

  const notify = useCallback(
    (
      message: string,
      level: NotificationLevel,
      opts?: NotifyOpts,
    ) => {
      const now = Date.now();
      const code = opts?.code;

      // VSCode 通知同款:同 level + 同 message 的通知还在列表里(显示中或排队中)就合并为一条 —— 计数 +1、
      // 刷新自动消失计时(排队中的没有计时,补位时才开始),不再堆出多条相同 toast。error 同样合并。
      let existing: Notification | undefined;
      for (let i = notificationsRef.current.length - 1; i >= 0; i--) {
        const n: Notification | undefined = notificationsRef.current[i];
        if (n !== undefined && n.level === level && n.message === message) {
          existing = n;
          break;
        }
      }
      if (existing) {
        const existingId = existing.id;
        notificationsRef.current = mergeRepeatedNotification(notificationsRef.current, existingId, now);
        setNotificationList((prev) => mergeRepeatedNotification(prev, existingId, now));
        if (timersRef.current.has(existingId)) scheduleDismiss(existingId, level);
        return;
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
      armVisibleTimers();
    },
    [armVisibleTimers, clearDismissTimer, scheduleDismiss, setNotificationList],
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

