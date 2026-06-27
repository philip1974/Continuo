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
import { useEditorStore, type EditorTab } from '@/stores/editor.store';
import { dirname } from '@/panels/Explorer/path-utils';
import { pathEquals } from '@/lib/path-cross';
import { findEditorFileTabById } from './editor-tab-lookup';
// 跨平台(codex 复查 P1):此前本地 dirname 是 Explorer path-utils dirname 的有问题副本 ——
// 对 `C:\a.md` 返回 drive-relative `C:`(应盘根 `C:\`,同 X2)、对 POSIX 根 `/a.md` 返回 ''
// (应 `/`),且下方比较为字节级 → Windows 盘根/大小写不同目录、甚至 mac 根 workspace 的
// clean tab 收不到外部 reload → 旧内容覆盖磁盘新内容。改为复用已修正的共享 dirname + 平台
// 感知 pathEquals 比较(watcher 广播路径规范化属另议平台 DEFER,本修不依赖其精确格式)。

export function useExternalFileSync(): void {
  useEffect(() => {
    // race(R79):effect cleanup 此前只 unsub,不让在途 readFile 失效。EditorPanel 卸载/重挂或
    // StrictMode 双 effect 时,旧 effect 的慢读仍会在 .then 里调 reloadFromDisk(tabId, 旧快照),
    // 把 clean tab 回滚成迟到的旧磁盘内容 → 用户随后基于旧内容编辑/保存覆盖外部真实新内容。
    // cancelled 令牌:cleanup 置真,settle 落地前校验仍是当前 effect,过期结果直接丢弃。
    let cancelled = false;
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

    // resolve/reject 两路共用收尾:无论成功失败都清 inFlight 并尾随重读 pending。
    // 数据安全(codex P2):readFile 的 promise reject(桥/进程/通道异常,非 handler 的
    // {ok:false})此前无 catch → inFlight 永不清,该 path 后续 dir-changed 只 pending.add
    // 不再重读 → clean tab 长期停旧内容,用户基于旧内容编辑保存覆盖外部真实新内容。
    const settle = (
      path: string,
      tabId: string,
      tabRef: EditorTab | null,
      r: { ok: true; data: string } | { ok: false } | null,
    ): void => {
      // race(R79):effect 已 cleanup(卸载/重挂/StrictMode 双跑)→ 本次是过期 effect 的迟到
      // 结果,直接丢弃,绝不 reloadFromDisk(否则用旧快照回滚 clean tab)。inFlight/pending
      // 随 effect 闭包一并 GC,无需在此清理。
      if (cancelled) return;
      inFlight.delete(path);
      const superseded = pending.delete(path); // 在途期间又有事件?
      // 未被尾随事件取代且读成功 → 应用。r=null(reject)本次不 reloadFromDisk(不拿失败/陈旧覆盖)。
      if (!superseded && r && r.ok) {
        // race(R97):tab.id===filePath,close+reopen 同路径会得到同 id 的**新** tab 对象;旧读迟到
        // 回写会覆盖新 tab(新 tab 可能已是更新内容 / 用户随后编辑保存把较新内容回退)。store 更新
        // 用 slice()+只替换变更项,未变 tab 保留对象 identity → 发起读取时捕获 tabRef,落地前复查
        // live tab 仍是同一实例(未被 close+reopen、未被更新的 reload 替换、未变 dirty)才回写;否则丢弃。
        const live = findEditorFileTabById(useEditorStore.getState().tabs, tabId);
        if (live !== null && live === tabRef) {
          useEditorStore.getState().reloadFromDisk(tabId, r.data);
        }
      }
      // 被合并的尾随事件 → 读最终内容并应用(本次中间结果已被取代,不落地)
      if (superseded) readAndApply(path, tabId);
    };

    const readAndApply = (path: string, tabId: string): void => {
      // race(R97):捕获发起读取时的 tab 实例引用,供 settle 复查(防 close+reopen 同路径迟到覆盖)。
      const tabRef = findEditorFileTabById(useEditorStore.getState().tabs, tabId);
      inFlight.add(path);
      void coApi.fs.readFile(path).then(
        (r) => settle(path, tabId, tabRef, r),
        () => settle(path, tabId, tabRef, null), // reject → 不落地,但仍清 inFlight/尾随重读
      );
    };

    const unsub = coApi.fs.onDirChanged((changedDir) => {
      const tabs = useEditorStore.getState().tabs;
      for (const tab of tabs) {
        if (tab.filePath === null) continue;
        if (tab.dirty) continue; // 保留用户改动,不覆盖
        if (!pathEquals(dirname(tab.filePath), changedDir)) continue;
        if (inFlight.has(tab.filePath)) {
          pending.add(tab.filePath); // 合并:在途读完成后尾随一次
        } else {
          readAndApply(tab.filePath, tab.id);
        }
      }
    });
    return () => {
      cancelled = true; // race(R79):失效在途 readFile 的迟到 settle
      unsub();
    };
  }, []);
}
