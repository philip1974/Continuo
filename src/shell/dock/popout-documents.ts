// 当前 dockview popout 子窗的 document 集合(供 ToastViewport 把 toast 也 portal 进子窗)。
//
// popout 子窗里的面板由主窗 React 经 portal 渲染,代码运行在主窗 JS 环境;主窗 position:fixed 的 toast 视口
// 只在主窗文档,面板弹出到另一屏后其 notify.* 子窗看不到。dockview 没有「popout 窗口打开 / 关闭」事件:
// 子窗打开后组的 location 为 { type: 'popout', getWindow },关闭时组回到 grid / floating(onDidLocationChange)
// 或被移除(onDidRemoveGroup);新组(含 fromJSON 恢复、弹出时新建的组)都经 onDidAddGroup。每次全量对账。

import type { DockviewApi } from 'dockview-react';

type Group = DockviewApi['groups'][number];

const EMPTY: readonly Document[] = [];
let current: readonly Document[] = EMPTY;
const subscribers = new Set<() => void>();

function publish(next: readonly Document[]): void {
  if (next.length === current.length && next.every((d, i) => d === current[i])) return;
  current = next.length === 0 ? EMPTY : next;
  for (const s of [...subscribers]) s();
}

/** 当前 popout 子窗文档(引用在集合不变时稳定,可直接作 useSyncExternalStore 快照)。 */
export function getPopoutDocuments(): readonly Document[] {
  return current;
}

/**
 * 读屏播报写进哪个窗口(`announce()` 的 doc):有焦点的 popout 子窗优先(用户正在看那一屏),否则主窗。
 * 每次播报只写一个文档,读屏不重复。
 */
export function getAnnouncingDocument(): Document {
  for (const doc of current) if (doc.hasFocus()) return doc;
  return document;
}

export function subscribePopoutDocuments(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export function trackPopoutDocuments(api: DockviewApi): { dispose: () => void } {
  const watched = new Map<Group, { dispose: () => void }>();

  const sync = (): void => {
    const live = new Set<Group>(api.groups);
    for (const [group, sub] of watched) {
      if (live.has(group)) continue;
      sub.dispose();
      watched.delete(group);
    }
    const docs = new Set<Document>();
    for (const group of live) {
      if (!watched.has(group)) watched.set(group, group.api.onDidLocationChange(sync));
      const loc = group.api.location;
      if (loc.type !== 'popout') continue;
      const doc = loc.getWindow()?.document;
      if (doc && doc !== document) docs.add(doc);
    }
    publish([...docs]);
  };

  const subs = [api.onDidAddGroup(sync), api.onDidRemoveGroup(sync)];
  sync();

  return {
    dispose: () => {
      for (const s of subs) s.dispose();
      for (const s of watched.values()) s.dispose();
      watched.clear();
      publish(EMPTY);
    },
  };
}
