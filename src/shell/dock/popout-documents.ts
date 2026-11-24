// 按 dockview 组位置把 popout 子窗的 document 登记进应用文档集合(lib/app-documents),供全局热键在子窗生效。
//
// dockview 没有「popout 窗口打开 / 关闭」事件;子窗打开后组的 location 被置为 { type: 'popout', getWindow },
// 关闭时组回到 grid / floating(onDidLocationChange)或被移除(onDidRemoveGroup)。新组(含 fromJSON 恢复、
// 弹出时新建的组)都经 onDidAddGroup。每次全量对账:当前 popout 组的窗口文档 ↔ 已登记集合。

import type { DockviewApi } from 'dockview-react';
import { registerAppDocument } from '@/lib/app-documents';

type Group = DockviewApi['groups'][number];

export function trackPopoutDocuments(api: DockviewApi): { dispose: () => void } {
  const registered = new Map<Document, () => void>();
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
      if (doc) docs.add(doc);
    }
    for (const [doc, unregister] of registered) {
      if (docs.has(doc)) continue;
      unregister();
      registered.delete(doc);
    }
    for (const doc of docs) {
      if (!registered.has(doc)) registered.set(doc, registerAppDocument(doc));
    }
  };

  const subs = [api.onDidAddGroup(sync), api.onDidRemoveGroup(sync)];
  sync();

  return {
    dispose: () => {
      for (const s of subs) s.dispose();
      for (const s of watched.values()) s.dispose();
      watched.clear();
      for (const unregister of registered.values()) unregister();
      registered.clear();
    },
  };
}
