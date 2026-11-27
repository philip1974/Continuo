// 外部进程修改文件时,自动同步打开的 editor tab 内容(图片 tab 只比 stat 指纹,见 editor-image)。
//
// 触发源:Explorer 已展开目录被 fs.watch 监听,main 进程 broadcast
// `fs:dir-changed`。本 hook 订阅该事件,扫描已打开 tabs,命中父目录的
// 重读磁盘并通过 store.reloadFromDisk 同步。dirty tab 跳过,保护用户编辑。
//
// 本 hook 不主动 watchDir:watcher 来自 Explorer 已展开目录,以及有打开 tab 时 useExternalSyncRootWatch
// 持有的 workspace root watcher(不依赖侧栏 / 文件树是否挂载,见该文件)。
// watcher 因 error 被驱逐后由 Explorer 重装成功时,断线期间的变化不会有 dir-changed;
// 订阅本地 watch-restored(src/lib/fs-watch-restored.ts),复查该目录子树内的 tab。
//
// 外部删除(确认后仍不存在)不关 tab:干净 / 脏都保留并标「(已删除)」(VSCode closeOnFileDelete: false,
// editor store markPathsDeleted);文件重新出现 → 清除标记(干净 tab 按磁盘重载)。资源管理器删除仍关干净 tab。
// 工作区根自身被改名 / 删除 / 恢复:main 推 fs:root-presence-changed,复查根下全部 tab(同 watch-restored)。
// 已标「(已删除)」的 tab 另有低频复查(ORPHANED_RECHECK_MS 一次 + 窗口获得焦点时):不依赖文件事件 —— 卷卸载后挂回、
// 网络盘重连等场景 watcher 不一定再报这个文件(VSCode 文件重新出现即清除 orphaned),发现文件回来即清除并恢复自动保存。

import { useEffect } from 'react';
import { coApi } from '@/lib/co-api';
import { onWatchRestored } from '@/lib/fs-watch-restored';
import { useEditorStore, type EditorTab } from '@/stores/editor.store';
import {
  basename,
  dirname,
  isPathSeparatorCode,
  isSameOrInsidePath,
  pathEquals,
  stripRootPrefix,
} from '@/lib/path-cross';
import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';
import { allSettledWithConcurrency } from '@/lib/map-with-concurrency';
import { findEditorFileTabById } from './editor-tab-lookup';
import { ownSaveStatCheck } from './saved-disk-stat';
import { readEditorFile } from './editor-image';
import { readEncodingOf, readOptionsForTab } from './editor-encoding';
import type { TextEncodingId } from '../../../electron/shared/text-encoding';
import { ERROR_CODES } from '../../../electron/shared/error-codes';

/** watch-restored 子树重读的最大同时在途 readFile 数(与 hydrateEditorTabs RESTORE_READ_CONCURRENCY 同口径). */
const RESTORED_RELOAD_CONCURRENCY = 32;

/**
 * 外部删除确认延迟:读到 FS_NOT_FOUND 后等这么久再读一次,仍不存在才按删除处理。
 * 「先删后建」式替换(部分编辑器 / git checkout)的间隙会短暂读不到,不能据此关 tab。
 */
export const EXTERNAL_DELETE_CONFIRM_MS = 500;

/** 已标「(已删除)」的 tab 的存在性复查周期(另在窗口获得焦点时复查)。只 stat,不读内容;没有已删除 tab 时什么都不做。 */
export const ORPHANED_RECHECK_MS = 5000;

type ReadResult =
  | { ok: true; data: string; realPath?: string; encoding?: TextEncodingId }
  | { ok: false; code?: string }
  | null;

const isNotFound = (r: ReadResult): boolean => r !== null && !r.ok && r.code === ERROR_CODES.FS_NOT_FOUND;

/**
 * 性能:编辑器自己保存的回声识别。原子写(tmp + rename)让 watcher 上报被保存文件本身,此前保存后
 * (tab 已 clean)总要再整文件读一次、reloadFromDisk 发现内容相同什么也不改(Markdown 2s autosave
 * 每次多一次整文件读 + IPC)。有本 tab 当前基线的保存记录时先发廉价 fs:stat 比对:{mtimeMs,size}
 * 与写入时一致 → 磁盘仍是自己写的内容,跳过 readFile。不一致 / stat 失败(含 reject)→ 照旧读。
 * 无适用记录 → 返回 null,调用方照旧**同步**发起 readFile(时序与改动前一致)。
 */
function ownSaveEchoCheck(path: string, tab: EditorTab | null): Promise<boolean> | null {
  return tab ? ownSaveStatCheck(path, tab.savedGen, (p) => coApi.fs.stat(p)) : null;
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
      r: ReadResult,
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
          useEditorStore.getState().reloadFromDisk(tabId, r.data, r.realPath, { encoding: readEncodingOf(r) });
        }
      }
      // 外部删除 / 改名(确认后仍不存在,如 git checkout 切到删除它的分支):不关 tab(VSCode closeOnFileDelete:
      // false;此前关闭,切回分支后 tab 不回来、⇧⌘T 也找不回)—— 保留并标记已删除(markPathsDeleted),自动保存
      // 不再写回(否则继续输入后把文件写回,mv 时与新名并存两份)。手动保存:仅文件被删、父目录仍在 → 按路径重建;
      // 所在目录被移走 / 删除 → atomic-write 不建父目录,保存失败报 FS_NOT_FOUND,须用户另存。
      // 同样要求 live tab 仍是发起读取时那个实例(未变脏 / 未重开)。
      if (!superseded && isNotFound(r)) {
        const live = findEditorFileTabById(useEditorStore.getState().tabs, tabId);
        if (live !== null && live === tabRef) useEditorStore.getState().markPathsDeleted([path]);
      }
      // 已标「(已删除)」的干净 tab 重读失败但不是「不存在」(如文件回来了却无读权限):读失败本身照旧静默跳过、内容不动,
      // 但标记改由存在性检查决定(同脏 tab 的 checkOrphan)—— VSCode:文件重新出现即清除 deleted 状态,读错误另行处理。
      // 否则标记不清、自动保存一直关着。(已标记的 tab 不做回声判断,这里的 {ok:false} 必是真实读失败。)
      if (!superseded && r && !r.ok && !isNotFound(r) && tabRef?.orphaned) {
        const live = findEditorFileTabById(useEditorStore.getState().tabs, tabId);
        if (live !== null && live === tabRef) checkOrphan(path, tabId);
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
      // 已标记删除的 tab 不做回声判断:mv 走再 mv 回不改 mtime / size / ino,stat 仍与保存记录一致,跳过读盘
      // 就永远清不掉「(已删除)」(VSCode:文件重新出现即清除)—— 照常读盘,reloadFromDisk 清除标记。
      const echoCheck = tabRef?.orphaned ? null : ownSaveEchoCheck(path, tabRef);
      // 用户选定过编码(通过编码重新打开 / 保存)→ 按它解码,否则自动识别(GBK 等自动识别必失败,外部修改就再也同步不进来)
      const readOpts = readOptionsForTab(tabRef);
      const first: Promise<ReadResult> = echoCheck
        ? echoCheck.then(
            (echo): ReadResult | Promise<ReadResult> => (echo ? { ok: false } : readEditorFile(coApi.fs, path, readOpts)),
          )
        : readEditorFile(coApi.fs, path, readOpts);
      // 读到不存在 → 延迟后再读一次确认(仍在 inFlight 内:等待期间的新事件并入尾随重读)。
      const read = first.then((r) =>
        isNotFound(r)
          ? new Promise<void>((res) => setTimeout(res, EXTERNAL_DELETE_CONFIRM_MS)).then(
              (): ReadResult | Promise<ReadResult> => (cancelled ? null : readEditorFile(coApi.fs, path, readOpts)),
            )
          : r,
      );
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
    const matchingTabs = (
      match: (filePath: string, realPath: string | undefined) => boolean,
      dirty: boolean,
    ): EditorTab[] => {
      const out: EditorTab[] = [];
      for (const tab of useEditorStore.getState().tabs) {
        if (tab.dirty !== dirty) continue;
        if (match(tab.filePath, tab.realPath)) out.push(tab);
      }
      return out;
    };
    // 干净 tab 才重读内容;脏 tab 保留用户改动,不覆盖
    const matchingCleanTabs = (
      match: (filePath: string, realPath: string | undefined) => boolean,
    ): EditorTab[] => matchingTabs(match, false);

    // 脏 tab 不重读内容,只查磁盘上是否还在(廉价 stat):确认已删除(同上 EXTERNAL_DELETE_CONFIRM_MS 复查)→ 标记
    // orphaned(tab 显示「(已删除)」、自动保存不再写回);文件重新出现 → 清除。同 path 在途时合并为尾随一次。
    const orphanInFlight = new Set<string>();
    const orphanPending = new Set<string>();
    const statNotFound = async (path: string): Promise<boolean | null> => {
      try {
        const r = await coApi.fs.stat(path);
        return r.ok ? false : r.code === ERROR_CODES.FS_NOT_FOUND ? true : null;
      } catch {
        return null; // 无法确认 → 不改标记
      }
    };
    const checkOrphan = (path: string, tabId: string): void => {
      if (orphanInFlight.has(path)) {
        orphanPending.add(path);
        return;
      }
      orphanInFlight.add(path);
      void (async () => {
        let gone = await statNotFound(path);
        if (gone === true && !cancelled) {
          await new Promise((res) => setTimeout(res, EXTERNAL_DELETE_CONFIRM_MS));
          gone = cancelled ? null : await statNotFound(path);
        }
        if (cancelled) return;
        orphanInFlight.delete(path);
        if (orphanPending.delete(path)) {
          checkOrphan(path, tabId); // 期间又有事件:以最新状态为准
          return;
        }
        if (gone === true) useEditorStore.getState().markPathsDeleted([path]);
        else if (gone === false) useEditorStore.getState().setOrphaned(tabId, false);
      })();
    };

    // dir-changed:精确匹配直接父目录(+ 可选文件名集合),命中数通常很小,直接逐个发起。
    const reloadMatching = (
      match: (filePath: string, realPath: string | undefined) => boolean,
    ): void => {
      for (const tab of matchingCleanTabs(match)) void requestReload(tab.filePath!, tab.id);
    };

    // watch-restored / 根消失或恢复:覆盖整棵子树(macOS/Win 的 watcher 递归,断线期间子目录里的变化同样丢失)。
    // 脏 tab 只查存在性(checkOrphan,廉价 stat):根恢复 / watcher 重装后清除其已删除标记。
    // 内存:此前对子树内全部 clean tab 同时发起整文件 readFile(256 tab × 大文件 → main 峰值内存 GB 级),
    // 改为有界并发(同 hydrateEditorTabs 的 RESTORE_READ_CONCURRENCY)。排队项在真正发起时再复查
    // (effect 已卸载 / tab 已关或变 dirty → 跳过;该 path 已被 dir-changed 读取在途 → 并入 pending
    // 尾随一次),保持每 path 读严格串行。
    const reloadSubtree = (dir: string): void => {
      const inDir = (fp: string, rp: string | undefined): boolean =>
        isSameOrInsidePath(dir, fp) || (rp !== undefined && isSameOrInsidePath(dir, rp));
      for (const tab of matchingTabs(inDir, true)) checkOrphan(tab.filePath, tab.id);
      const targets = matchingCleanTabs(inDir);
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
    // 目录改名 / 移动 / 删除:macOS 递归 fs.watch 对 `mv src/foo src/bar` 只报 {dir:src, files:[foo, bar]},
    // 不列目录内文件 → 集合中的名字可能是 tab 的祖先目录。tab 在 changedDir 子树深处(非直接子项)且其相对
    // 路径首段命中集合 → 同样纳入重读;读到不存在即走 markPathsDeleted(与文件层同一出口)。
    const subtreeHit = (changedDir: string, names: ReadonlySet<string>, p: string): boolean => {
      if (!isSameOrInsidePath(changedDir, p)) return false;
      const rel = stripRootPrefix(changedDir, p);
      let i = 0;
      while (i < rel.length && !isPathSeparatorCode(rel.charCodeAt(i))) i++;
      return i < rel.length && names.has(foldFileName(rel.slice(0, i)));
    };
    const unsub = coApi.fs.onDirChanged((changedDir, files) => {
      const names = files ? new Set(files.map(foldFileName)) : null;
      const nameHit = (p: string): boolean => names!.has(foldFileName(basename(p)));
      const match = (fp: string, rp: string | undefined): boolean =>
        ((pathEquals(dirname(fp), changedDir) ||
          (rp !== undefined && pathEquals(dirname(rp), changedDir))) &&
          (names === null || nameHit(fp) || (rp !== undefined && nameHit(rp)))) ||
        (names !== null &&
          (subtreeHit(changedDir, names, fp) ||
            (rp !== undefined && subtreeHit(changedDir, names, rp))));
      reloadMatching(match);
      for (const tab of matchingTabs(match, true)) checkOrphan(tab.filePath, tab.id);
    });
    // 已删除 tab 的低频复查:文件回来了(stat 存在)→ 干净 tab 重读(reloadFromDisk 清除标记),脏 tab 走 checkOrphan 清除
    //(恢复自动保存;写回前 checkDiskBeforeSave 仍会比对磁盘内容,不会覆盖期间出现的不同内容)。仍不存在 → 不动。
    // 上一轮还没查完不叠加;有界并发(卷整个卸载时根下可能有很多已删除 tab)。
    let recheckRunning = false;
    const recheckOrphaned = (): void => {
      if (cancelled || recheckRunning) return;
      const targets = useEditorStore.getState().tabs.filter((t) => t.orphaned === true);
      if (targets.length === 0) return;
      recheckRunning = true;
      void allSettledWithConcurrency(targets, RESTORED_RELOAD_CONCURRENCY, async (t) => {
        if (cancelled) return;
        const gone = await statNotFound(t.filePath);
        if (gone !== false || cancelled) return;
        const live = findEditorFileTabById(useEditorStore.getState().tabs, t.id);
        if (live === null || !live.orphaned || live.filePath !== t.filePath) return;
        if (live.dirty) checkOrphan(live.filePath, live.id);
        else await requestReload(live.filePath, live.id);
      }).finally(() => {
        recheckRunning = false;
      });
    };
    const recheckTimer = setInterval(recheckOrphaned, ORPHANED_RECHECK_MS);
    window.addEventListener('focus', recheckOrphaned);
    const unsubRestored = onWatchRestored(reloadSubtree);
    // 工作区根自身被改名 / 删除(根下文件名匹配不到 tab)/ 之后恢复:复查根下全部 tab。
    const unsubRootPresence = coApi.fs.onRootPresenceChanged(reloadSubtree);
    return () => {
      cancelled = true; // race(R79):失效在途 readFile 的迟到 settle
      clearInterval(recheckTimer);
      window.removeEventListener('focus', recheckOrphaned);
      unsub();
      unsubRestored();
      unsubRootPresence();
    };
  }, []);
}
