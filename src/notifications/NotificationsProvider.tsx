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
import type { NotifyApi } from './notify';

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

export interface NotifyOpts {
  readonly code?: string;
  readonly mirror?: boolean; // notify.ts 用;Provider 内部不读
}

interface NotificationsContextValue {
  readonly notifications: readonly Notification[];
  readonly notify: (
    message: string,
    level?: NotificationLevel,
    opts?: NotifyOpts,
  ) => void;
  readonly dismiss: (id: string) => void;
}

export const NotificationsContext =
  createContext<NotificationsContextValue>({
    notifications: [],
    notify: () => {
      /* noop pre-mount */
    },
    dismiss: () => {
      /* noop */
    },
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
    [],
  );
  const notificationsRef = useRef<readonly Notification[]>([]);
  const counterRef = useRef(0);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const setNotificationList = useCallback(
    (
      next:
        | readonly Notification[]
        | ((
            prev: readonly Notification[],
          ) => readonly Notification[]),
    ) => {
      setNotifications((prev) => {
        const resolved =
          typeof next === 'function' ? next(prev) : next;
        notificationsRef.current = resolved;
        return resolved;
      });
    },
    [],
  );

  const dismiss = useCallback(
    (id: string) => {
      const t = timersRef.current.get(id);
      if (t !== undefined) {
        clearTimeout(t);
        timersRef.current.delete(id);
      }
      // race(R104,R13 对偶):同步从 notificationsRef 移除,使同一 tick 内后续 notify 的 dedupe
      // 不再看到已关闭通知。否则 dismiss() 只在 setNotificationList 的 updater(延迟到 render)里更新
      // ref —— 同 tick 紧接的同源 non-error notify 会从旧 ref 匹配到这条「已关闭」通知走 dedupe 分支:
      // 既不新增也不复活(其 map updater 在 dismiss 的 filter updater 之后跑,existing.id 已不在 prev
      // → no-op),新通知被静默吞掉;还给已删 id 重挂 auto-dismiss timer。下面 functional updater 仍
      // 是权威(落 ref);此处同步值仅为同 tick 先行可见,与 R13 notify 侧同步写 ref 对称。
      notificationsRef.current = notificationsRef.current.filter(
        (n) => n.id !== id,
      );
      setNotificationList((prev) => prev.filter((n) => n.id !== id));
    },
    [setNotificationList],
  );

  const scheduleDismiss = useCallback(
    (id: string, level: NotificationLevel) => {
      const existing = timersRef.current.get(id);
      if (existing !== undefined) clearTimeout(existing);
      const t = setTimeout(() => {
        timersRef.current.delete(id);
        setNotificationList((prev) => prev.filter((p) => p.id !== id));
      }, DISMISS_MS[level]);
      timersRef.current.set(id, t);
    },
    [setNotificationList],
  );

  const notify = useCallback(
    (
      message: string,
      level: NotificationLevel = 'info',
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
          setNotificationList((prev) =>
            prev.map((n) =>
              n.id === existing.id ? { ...n, createdAt: now } : n,
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
      notificationsRef.current = [...notificationsRef.current, n];
      setNotificationList((prev) => {
        const next = [...prev, n];
        if (next.length <= MAX_NOTIFICATIONS) return next;
        // 丢最旧的若干条,并清掉它们的 auto-dismiss timer,防 timer 泄漏。
        const dropCount = next.length - MAX_NOTIFICATIONS;
        for (let i = 0; i < dropCount; i++) {
          const dropped = next[i];
          if (dropped === undefined) continue;
          const t = timersRef.current.get(dropped.id);
          if (t !== undefined) {
            clearTimeout(t);
            timersRef.current.delete(dropped.id);
          }
        }
        return next.slice(dropCount);
      });
      scheduleDismiss(id, level);
    },
    [scheduleDismiss, setNotificationList],
  );

  // epoch race 防护:mount 时注册,unmount 时仅当自身 epoch === 当前 currentEpoch 才清空
  useEffect(() => {
    const myEpoch = ++moduleEpoch;
    const api: NotifyApi = { notify, dismiss };
    __registerHandle(api, myEpoch);
    return () => {
      // 仅在自身仍是当前 epoch 时清空(防 StrictMode 双 mount / HMR 旧实例 unmount 清新单例)
      __registerHandle(null, myEpoch);
    };
  }, [notify, dismiss]);

  // unmount 清所有 timer
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const value = useMemo<NotificationsContextValue>(
    () => ({ notifications, notify, dismiss }),
    [notifications, notify, dismiss],
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

export type { NotifyApi } from './notify';
