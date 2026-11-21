// 外部进程修改文件时,自动同步打开的 editor tab 内容。
//
// 触发源:Explorer 已展开目录被 fs.watch 监听,main 进程 broadcast
// `fs:dir-changed`。本 hook 订阅该事件,扫描已打开 tabs,命中父目录的
// 重读磁盘并通过 store.reloadFromDisk 同步。dirty tab 跳过,保护用户编辑。
//
// 注意:本 hook 不主动 watchDir,完全复用 Explorer 已 watch 的目录列表。
// 父目录未展开的文件收不到通知(用户需手动刷新);95% 场景下打开文件
// 之前 Explorer 已展开/reveal 过该路径。
// watcher 因 error 被驱逐后由 Explorer 重装成功时,断线期间的变化不会有 dir-changed;
// 订阅本地 watch-restored(src/lib/fs-watch-restored.ts),重读该目录子树内的 clean tab。

import { useEffect } from 'react';
import { coApi } from '@/lib/co-api';
import { onWatchRestored } from '@/lib/fs-watch-restored';
import { useEditorStore, type EditorTab } from '@/stores/editor.store';
import { dirname } from '@/panels/Explorer/path-utils';
import { basename, isSameOrInsidePath, pathEquals } from '@/lib/path-cross';
import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';
import { allSettledWithConcurrency } from '@/lib/map-with-concurrency';
import { findEditorFileTabById } from './editor-tab-lookup';
import { getSavedDiskStat, isSameDiskStat } from './saved-disk-stat';

/** watch-restored 子树重读的最大同时在途 readFile 数(与 hydrateEditorTabs RESTORE_READ_CONCURRENCY 同口径). */
const RESTORED_RELOAD_CONCURRENCY = 32;

/**
 * 性能:编辑器自己保存的回声识别。原子写(tmp + rename)让 watcher 上报被保存文件本身,此前保存后
 * (tab 已 clean)总要再整文件读一次、reloadFromDisk 发现内容相同什么也不改(Markdown 2s autosave
 * 每次多一次整文件读 + IPC)。有本 tab 当前基线的保存记录时先发廉价 fs:stat 比对:{mtimeMs,size}
 * 与写入时一致 → 磁盘仍是自己写的内容,跳过 readFile。不一致 / stat 失败(含 reject)→ 照旧读。
 * 无适用记录 → 返回 null,调用方照旧**同步**发起 readFile(时序与改动前一致)。
 */
function ownSaveEchoCheck(path: string, tab: EditorTab | null): Promise<boolean> | null {
  const rec = getSavedDiskStat(path);
  if (!rec || !tab || tab.savedGen !== rec.gen) return null;
  return (async () => {
    try {
      const st = await coApi.fs.stat(path);
      return st.ok && isSameDiskStat(st.data, rec);
    } catch {
      return false;
    }
  })();
}

/** dir-changed 文件名匹配键:大小写 + Unicode NFC 折叠(宁多读不漏读,见下方订阅处注释). */
function foldFileName(name: string): string {
  return lowerIfNeeded(name.normalize('NFC'));
}
// 跨平台(复查 P1):此前本地 dirname 是 Explorer path-utils dirname 的有问题副本 ——
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
    // 数据安全(P2):readFile 的 promise reject(桥/进程/通道异常,非 handler 的
    // {ok:false})此前无 catch → inFlight 永不清,该 path 后续 dir-changed 只 pending.add
    // 不再重读 → clean tab 长期停旧内容,用户基于旧内容编辑保存覆盖外部真实新内容。
    const settle = (
      path: string,
      tabId: string,
      tabRef: EditorTab | null,
      r: { ok: true; data: string; realPath?: string } | { ok: false } | null,
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
          useEditorStore.getState().reloadFromDisk(tabId, r.data, r.realPath);
        }
      }
      // 被合并的尾随事件 → 读最终内容并应用(本次中间结果已被取代,不落地)
      if (superseded) readAndApply(path, tabId);
    };

    // 返回本次读取 settle 完成的 promise(供 watch-restored 有界并发计在途;尾随重读不计入)。
    const readAndApply = (path: string, tabId: string): Promise<void> => {
      // race(R97):捕获发起读取时的 tab 实例引用,供 settle 复查(防 close+reopen 同路径迟到覆盖)。
      const tabRef = findEditorFileTabById(useEditorStore.getState().tabs, tabId);
      inFlight.add(path);
      // 保存回声:跳过整文件读,按「不落地」settle(仍清 inFlight / 尾随重读 pending)。
      const echoCheck = ownSaveEchoCheck(path, tabRef);
      const read: Promise<Parameters<typeof settle>[3]> = echoCheck
        ? echoCheck.then(
            (echo): Parameters<typeof settle>[3] | Promise<Parameters<typeof settle>[3]> =>
              echo ? { ok: false } : coApi.fs.readFile(path),
          )
        : coApi.fs.readFile(path);
      return read.then(
        (r) => settle(path, tabId, tabRef, r),
        () => settle(path, tabId, tabRef, null), // reject → 不落地,但仍清 inFlight/尾随重读
      );
    };

    // 单个 tab 的重读入口:在途则合并为尾随一次,否则立即读。
    const requestReload = (path: string, tabId: string): Promise<void> | undefined => {
      if (inFlight.has(path)) {
        pending.add(path); // 合并:在途读完成后尾随一次
        return undefined;
      }
      return readAndApply(path, tabId);
    };

    // symlink tab:filePath 是打开路径(链接),realPath 是读盘时 main 解析的真实目标(见 EditorTab.realPath)。
    // FSEvents/inotify 上报的是被实际修改的目录项(链接目标),故匹配谓词同时收到两者,任一侧命中即重读
    //(重读仍经 filePath 读,读到的就是目标内容)。
    const matchingCleanTabs = (
      match: (filePath: string, realPath: string | undefined) => boolean,
    ): EditorTab[] => {
      const out: EditorTab[] = [];
      for (const tab of useEditorStore.getState().tabs) {
        if (tab.filePath === null) continue;
        if (tab.dirty) continue; // 保留用户改动,不覆盖
        if (match(tab.filePath, tab.realPath)) out.push(tab);
      }
      return out;
    };

    // dir-changed:精确匹配直接父目录(+ 可选文件名集合),命中数通常很小,直接逐个发起。
    const reloadMatching = (
      match: (filePath: string, realPath: string | undefined) => boolean,
    ): void => {
      for (const tab of matchingCleanTabs(match)) void requestReload(tab.filePath!, tab.id);
    };

    // watch-restored:覆盖整棵子树(macOS/Win 的 watcher 递归,断线期间子目录里的变化同样丢失)。
    // 内存:此前对子树内全部 clean tab 同时发起整文件 readFile(256 tab × 大文件 → main 峰值内存 GB 级),
    // 改为有界并发(同 hydrateEditorTabs 的 RESTORE_READ_CONCURRENCY)。排队项在真正发起时再复查
    // (effect 已卸载 / tab 已关或变 dirty → 跳过;该 path 已被 dir-changed 读取在途 → 并入 pending
    // 尾随一次),保持每 path 读严格串行。
    const reloadSubtree = (dir: string): void => {
      const targets = matchingCleanTabs(
        (fp, rp) => isSameOrInsidePath(dir, fp) || (rp !== undefined && isSameOrInsidePath(dir, rp)),
      );
      void allSettledWithConcurrency(targets, RESTORED_RELOAD_CONCURRENCY, async (t) => {
        if (cancelled) return;
        const live = findEditorFileTabById(useEditorStore.getState().tabs, t.id);
        if (live === null || live.dirty || live.filePath !== t.filePath) return;
        await requestReload(t.filePath!, t.id);
      });
    };
    // 性能:main 带上变更文件名集合时只重读命中的 clean tab(此前每次 dir-changed 都把该目录下所有
    // clean tab 整文件读回,Markdown 2s 自动保存 / 根目录持续写日志时几乎不停读盘);无集合(平台不给
    // filename / 缓冲溢出 / 超上限)→ 退化为按目录匹配。目录仍按 pathEquals(dirname) 判定;文件名比较
    // 故意更宽松(大小写 + Unicode NFC 折叠):误命中只多读一次(= 旧行为),漏命中会让 clean tab 停旧内容。
    // symlink tab:目录取 dirname(filePath) 或 dirname(realPath),文件名取 basename(filePath) 或
    // basename(realPath),两侧不强制配对 —— 工作区经非 canonical 路径打开(如 /tmp → /private/tmp)时
    // realPath 的目录与广播目录字面不同,但同目录链接仍能由「链接目录 + 目标名」命中;交叉误命中只多读一次。
    const unsub = coApi.fs.onDirChanged((changedDir, files) => {
      const names = files ? new Set(files.map(foldFileName)) : null;
      const nameHit = (p: string): boolean => names!.has(foldFileName(basename(p)));
      reloadMatching(
        (fp, rp) =>
          (pathEquals(dirname(fp), changedDir) ||
            (rp !== undefined && pathEquals(dirname(rp), changedDir))) &&
          (names === null || nameHit(fp) || (rp !== undefined && nameHit(rp))),
      );
    });
    const unsubRestored = onWatchRestored(reloadSubtree);
    return () => {
      cancelled = true; // race(R79):失效在途 readFile 的迟到 settle
      unsub();
      unsubRestored();
    };
  }, []);
}
