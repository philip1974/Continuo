// 外部进程修改文件时,自动同步打开的 editor tab 内容。
//
// 触发源:Explorer 已展开目录被 fs.watch 监听,main 进程 broadcast
// `fs:dir-changed`。本 hook 订阅该事件,扫描已打开 tabs,命中父目录的
// 重读磁盘并通过 store.reloadFromDisk 同步。dirty tab 跳过,保护用户编辑。
//
// 注意:本 hook 不主动 watchDir,完全复用 Explorer 已 watch 的目录列表。
// 父目录未展开的文件收不到通知(用户需手动刷新);95% 场景下打开文件
// 之前 Explorer 已展开/reveal 过该路径。

import { useEffect } from 'react';
import { coApi } from '@/lib/co-api';
import { useEditorStore } from '@/stores/editor.store';

function dirname(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(0, idx) : '';
}

export function useExternalFileSync(): void {
  useEffect(() => {
    // 同一文件短时间内多次变更会广播多个 dir-changed(原子写 = 临时文件 + rename 多
    // 事件 / 格式化工具或生成器连续重写)。旧实现对每个事件都并发发起一次 readFile +
    // reloadFromDisk,只有最后一次有用,前面的 IPC + 磁盘读纯浪费;且并发读可能乱序
    // resolve 用陈旧内容覆盖新内容(topic-49 P2-BG)。
    //
    // 性能 P15:按 path 做 **in-flight 合并**——某 path 的 read 在途时,新事件不再并发
    // 发起,只标记 pending;在途 read 完成后若 pending 则**尾随重读一次**(读到 burst
    // 之后的最终内容),并跳过被它取代的中间结果。首个事件立即读(不加延迟),仅在途
    // 期间的事件被合并。每 path 读严格串行 → 不再有并发乱序回写(比旧 seqByPath 更强,
    // 直接取代之)。dirty tab 在事件与应用(reloadFromDisk 内再查 dirty)两处都跳过。
    // 注:tab.id === filePath(createTab 不变量),故同一文件不会开成两个 tab,按 path
    // 合并安全。
    const inFlight = new Set<string>();
    const pending = new Set<string>();

    const readAndApply = (path: string, tabId: string): void => {
      inFlight.add(path);
      void coApi.fs.readFile(path).then((r) => {
        inFlight.delete(path);
        const superseded = pending.delete(path); // 在途期间又有事件?
        if (!superseded && r.ok) {
          useEditorStore.getState().reloadFromDisk(tabId, r.data);
        }
        // 被合并的尾随事件 → 读最终内容并应用(本次中间结果已被取代,不落地)
        if (superseded) readAndApply(path, tabId);
      });
    };

    const unsub = coApi.fs.onDirChanged((changedDir) => {
      const tabs = useEditorStore.getState().tabs;
      for (const tab of tabs) {
        if (tab.filePath === null) continue;
        if (tab.dirty) continue; // 保留用户改动,不覆盖
        if (dirname(tab.filePath) !== changedDir) continue;
        if (inFlight.has(tab.filePath)) {
          pending.add(tab.filePath); // 合并:在途读完成后尾随一次
        } else {
          readAndApply(tab.filePath, tab.id);
        }
      }
    });
    return unsub;
  }, []);
}
