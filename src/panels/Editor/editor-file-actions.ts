// M-Editor Step E2:文件操作纯函数。
// React hook(useEditorFile)是薄壳,业务逻辑都在这里,可单测。
//
// MVP 简化(详见 doc/09 § MVP 范围):
//  - 只实现 openFileByPath / saveFile
//  - 不做 Cmd+O / Cmd+N / 另存为(Continuo fs IPC 暂无 open/saveDialog 通道)
//  - 新建/打开文件统一走 Explorer 右键菜单 + 单击

import type { FsApi } from '@/lib/fs/api';
import type { IpcResult } from '@/lib/fs/types';
import type { IpcFail } from '../../../electron/shared/ipc-result';
import { errorCodeOf, errorMessage } from '../../../electron/shared/error-message';
import { ERROR_CODES } from '../../../electron/shared/error-codes';
import {
  beginUserActivation,
  createTab,
  usesMilkdownEngine,
  getUserActivationGen,
  useEditorStore,
  type EditorTab,
} from '@/stores/editor.store';
import { runSerialPerKey } from '@/lib/serialize-per-key';
import type { FsReadFileResult } from '../../../electron/shared/fs-channels';
import {
  findEditorFileTabById,
  findEditorFileTabByPath,
  tabMatchesDiskPath,
} from './editor-tab-lookup';
import { getSavedDiskStat, ownSaveStatCheck, recordSavedDiskStat } from './saved-disk-stat';
import {
  loadCodeEditorModule,
  loadEditorPanelModule,
  loadMilkdownEditorModule,
} from './editor-engine-loaders';

/** renderer 内部错误码:保存时发现磁盘已被外部修改(未覆盖)。EditorPanel 据此弹覆盖确认,dirty-close 单独计数。 */
export const EDITOR_DISK_CHANGED = 'EDITOR_DISK_CHANGED';

const ignoreWarmupError = (): void => {};

/**
 * perf:首次打开文件时与 readFile 并行预热即将渲染的编辑引擎 chunk(此前要等 readFile + openTab 提交后
 * EditorPanel 渲染 lazy 引擎才开始拉)。引擎选择与 EditorPanel 同口径(usesMilkdownEngine):Markdown 且 getEffectiveMode 非 source
 * → Milkdown,否则 CodeEditor(读文件前无 tab,按 null tab 判定;unsafe 内容落 Source 时仅多拉一个 chunk)。
 * 共享 loader 去重、失败不缓存;fire-and-forget,失败吞掉(真正渲染时由引擎错误边界处理)。
 * 也供 Explorer 文件行 pointerdown 调用(意图早于 click,提前量更大)。
 */
export function warmEditorEngineFor(path: string): void {
  loadEditorPanelModule().catch(ignoreWarmupError);
  const engine =
    usesMilkdownEngine(path, null)
      ? loadMilkdownEditorModule()
      : loadCodeEditorModule();
  engine.catch(ignoreWarmupError);
}

// race(R21):同一 tab 的保存串行链。autosave(旧内容)在途时用户编辑 + 手动保存(新内容),若
// 二者乱序完成,旧内容会最后落盘覆盖新的。按 tabId 串行保证按发起顺序写盘,最后发起者最后落盘。
const saveChains = new Map<string, Promise<unknown>>();

export interface EditorFileDeps {
  /** stat 可选:有则保存前先用上次保存的 stat 基线做快路径(无则一律整读比对)。 */
  fs: Pick<FsApi, 'readFile' | 'writeFile'> & Partial<Pick<FsApi, 'stat'>>;
}

export type FileOpResult = IpcResult<void>;

const exception = (err: unknown): IpcFail => ({
  ok: false,
  // IPC reject 带的稳定 code 原样保留(无则 EXCEPTION),调用方才能按 code 本地化。
  code: errorCodeOf(err),
  message: errorMessage(err),
});

/**
 * Explorer 单击文件触发。已开过同 path → 只 switchTab(不重读);
 * 否则 fs.readFile + createTab + openTab。
 */
export async function openFileByPath(
  path: string,
  deps: EditorFileDeps,
): Promise<FileOpResult> {
  const r = await openTabWith(path, () => deps.fs.readFile(path), (tabs) =>
    findEditorFileTabByPath(tabs, path),
  );
  return r.ok ? OPENED : r;
}

const OPENED: FileOpResult = { ok: true, data: undefined };

/**
 * 安全(插件 editor.openFile):用主进程已校验并读出的内容开标签,不再经宿主受信通道按路径另读一次(见
 * src/__tests__/plugin-editor-open-verified/)。path 必须是主进程返回的 canonical 路径(不含链接,所以不带 realPath)。
 * 其余与 openFileByPath 相同:已开过 → 只切换(不覆盖已开标签的内容);用户激活代际;读后复检并发打开。
 * 「已开过」:canonical 路径或插件给的原路径 requestedPath 命中已有标签的打开路径或 realPath —— 用户经链接
 *(/tmp → /private/tmp、工作区软链)打开的标签 filePath 不是 canonical,只比 canonical 会多开一个同文件标签、各自记脏。
 * 只是切换到已有标签,内容仍只来自主进程校验后的读取(不按 requestedPath 读任何东西)。
 * 新建的标签带 pluginOpenedPath 标记(不进会话快照,关闭时释放主进程记录)。data = 是否新建了标签。
 */
export function openFileWithContent(
  path: string,
  content: string,
  requestedPath: string = path,
): Promise<IpcResult<boolean>> {
  const find = (tabs: readonly EditorTab[]): EditorTab | null =>
    findPluginOpenedTab(tabs, path, requestedPath);
  return openTabWith(path, async () => ({ ok: true, data: content }), find, path);
}

/**
 * 插件打开的文件对应的已开标签:真实路径或插件原路径命中标签的 filePath / realPath 任一。openFileWithContent 判重与
 * 插件 openFile 之后找标签跳行(co-app openInEditor)共用 —— 两处口径不同时会切到经链接路径打开的标签却找不到它跳行。
 */
export function findPluginOpenedTab(
  tabs: readonly EditorTab[],
  canonicalPath: string,
  requestedPath: string = canonicalPath,
): EditorTab | null {
  return (
    tabs.find((t) => tabMatchesDiskPath(t, canonicalPath) || tabMatchesDiskPath(t, requestedPath)) ??
    null
  );
}

/** data = 是否新建了标签(false:已开着只切换)。findExisting:判定「已开过」的查找(读前、读后各查一次)。 */
async function openTabWith(
  path: string,
  read: () => Promise<FsReadFileResult>,
  findExisting: (tabs: readonly EditorTab[]) => EditorTab | null,
  pluginOpenedPath?: string,
): Promise<IpcResult<boolean>> {
  const store = useEditorStore;
  // 已开过 → 只切换。跨平台(复查 P1):用平台感知 pathEquals 而非 `===` —— Windows
  // 上同一文件以 `C:\Repo\a.md` / `c:\repo\a.md` 不同大小写打开,`===` 判不等 → 开出两个
  // tab,分别编辑保存同一文件 → 后保存者覆盖前者丢改。switchTab 用**已存在 tab 的真实 id**
  // (大小写可能与传入 path 不同)。POSIX 大小写敏感不变(pathEquals 在非 Windows 即 ===)。
  const existing = findExisting(store.getState().tabs);
  if (existing) {
    store.getState().switchTab(existing.id);
    return { ok: true, data: false };
  }

  warmEditorEngineFor(path);

  // 用户激活代际(见 editor.store beginUserActivation):快速连续打开时读盘耗时不同的请求乱序完成,读盘期间
  // 用户也可能在 tab 栏切到别的 tab(store.switchTab)。读完后代际已被更晚的用户选择(另一次打开 / 切换)
  // 超越 → 仅后台加入 tab,不抢激活/焦点(参考 hydrateEditorTabs 迟到恢复的 activate:false)。
  const my = beginUserActivation();

  let r;
  try {
    r = await read();
  } catch (err) {
    return exception(err);
  }
  if (!r.ok) return r;

  // race(R20):check(上面 existing)→ read → create 之间是 TOCTOU 窗口。并发打开同一文件
  // (尤其 Windows 不同大小写路径 C:\Repo\a.md / c:\repo\a.md)时,两个调用都在读前看不到
  // existing,读后各自 createTab → 同一磁盘文件出现两个 tab,分别保存互相覆盖(重现 X10
  // pathEquals 想防的数据丢失)。读后、建 tab 前再用 pathEquals 复检 store,已存在则只切换。
  const latest = my === getUserActivationGen();
  const raced = findExisting(store.getState().tabs);
  if (raced) {
    if (latest) store.getState().switchTab(raced.id);
    return { ok: true, data: false };
  }

  const created = createTab(path, r.data, r.realPath);
  const tab = pluginOpenedPath === undefined ? created : { ...created, pluginOpenedPath };
  store
    .getState()
    .openTab(tab, latest ? undefined : { activate: false, requestFocus: false });
  // openTab 可能拒开(tab 数 / 路径长度上限)→ 按 store 里是否真有这个标签对象判定
  return { ok: true, data: store.getState().tabs.includes(tab) };
}

/**
 * Cmd+S 触发。
 * 成功后 store.markSaved。
 */
export interface SaveFileOptions {
  /** 用户已确认覆盖外部修改(EDITOR_DISK_CHANGED 后的「仍然覆盖」)→ 跳过磁盘比较。 */
  readonly force?: boolean;
}

export async function saveFile(
  tabId: string,
  deps: EditorFileDeps,
  opts?: SaveFileOptions,
): Promise<FileOpResult> {
  // race(R21):同 tab 的保存按发起顺序串行写盘 —— 防 autosave 旧内容晚于手动保存新内容落盘而
  // 覆盖。每次进链时重读 tab.content(在 task 内取快照),保证串行后写的是当时最新内容。
  return runSerialPerKey(saveChains, tabId, () => saveFileNow(tabId, deps, opts));
}

/**
 * 打磨 P2-BL:保存前检查磁盘自上次加载/保存后是否被外部改过(参考 VSCode「文件已在磁盘上更改」)。
 * dirty tab 不随外部修改 reload(useExternalFileSync 跳过),不比较就写会静默抹掉外部版本。
 * 返回 null = 可以写;否则返回应中止保存的结果。只有明确「不存在」(FS_NOT_FOUND,main readFile 对
 * ENOENT 的映射)才允许直接写(重建);其它读错误(无权限 / IO / bridge reject)无法确认磁盘状态,
 * 照写可能抹掉外部版本 → 中止并原样返回该错误(复审)。
 */
async function checkDiskBeforeSave(
  fs: EditorFileDeps['fs'],
  filePath: string,
  originalContent: string,
  savedGen: number | undefined,
): Promise<FileOpResult | null> {
  // 快路径:磁盘 stat 仍与本 tab 上次保存时记下的一致 → 磁盘就是那次写入的内容(= originalContent),
  // 不必整文件回读(与外部同步的保存回声识别同一判断,见 saved-disk-stat)。不一致 / 无记录 → 整读比对。
  // 只在记录的 mtime 带亚毫秒小数(高精度文件系统:APFS / ext4 / NTFS)时适用:粗粒度 mtime(FAT32 / exFAT /
  // HFS+ / 部分网络盘,mtimeMs 为整数)下外部原地写入同样大小的内容可能落在同一刻度、stat 不变,误判即覆盖外部
  // 版本 —— 外部同步误判只是少一次 reload,这里误判会丢数据,所以一律整读。
  const rec = getSavedDiskStat(filePath);
  const fastPathEligible = fs.stat !== undefined && rec !== undefined && !Number.isInteger(rec.mtimeMs);
  const own = fastPathEligible ? ownSaveStatCheck(filePath, savedGen, (p) => fs.stat!(p)) : null;
  if (own && (await own)) return null;
  let r: IpcResult<string>;
  try {
    r = await fs.readFile(filePath);
    if (!r.ok && r.code === ERROR_CODES.FS_NOT_FOUND) return null;
  } catch (err) {
    // reject 或畸形结果(读 .ok 抛错):带 FS_NOT_FOUND 的 reject 同样视为不存在,其它中止。
    return errorCodeOf(err) === ERROR_CODES.FS_NOT_FOUND ? null : exception(err);
  }
  if (!r.ok) return r;
  if (r.data === originalContent) return null;
  return {
    ok: false,
    code: EDITOR_DISK_CHANGED,
    message: `file changed on disk since last load/save: ${filePath}`,
  };
}

async function saveFileNow(
  tabId: string,
  deps: EditorFileDeps,
  opts?: SaveFileOptions,
): Promise<FileOpResult> {
  const { fs } = deps;
  const store = useEditorStore;
  let tab = findEditorFileTabById(store.getState().tabs, tabId);
  if (opts?.force !== true && tab) {
    const blocked = await checkDiskBeforeSave(fs, tab.filePath, tab.originalContent, tab.savedGen);
    if (blocked) return blocked;
  }
  // 读盘 await 期间 tab 可能被关闭/继续编辑 → 重取,写盘快照用最新内容。
  tab = findEditorFileTabById(store.getState().tabs, tabId);
  if (!tab) {
    return {
      ok: false,
      code: 'TAB_NOT_FOUND',
      message: `tab not found: ${tabId}`,
    };
  }
  // 快照本次写盘的内容。markSaved 用它判定写盘 await 期间是否发生并发编辑:
  // 若 store 里 content 已领先此快照,保留 dirty 不被静默清掉。
  const savedContent = tab.content;
  let r;
  try {
    r = await fs.writeFile(tab.filePath, savedContent);
  } catch (err) {
    return exception(err);
  }
  if (!r.ok) return r;

  // 性能:记录写入内容的 { mtimeMs, size, ino } + 保存代际(同写到 tab.savedGen),外部同步据此识别本次保存的
  // dir-changed 回声(免整文件重读)。
  const savedGen = recordSavedDiskStat(tab.filePath, r.data);
  store.getState().markSaved(tabId, savedContent, savedGen);
  return { ok: true, data: undefined };
}

/**
 * 还原文件(VSCode workbench.action.files.revert):重读磁盘,把 tab 换成磁盘内容并丢弃未保存的修改
 *(与外部同步同一出口 reloadFromDisk,Milkdown 视图按 reloadEpoch 重挂)。读盘失败原样返回,tab 不变。
 */
export async function revertFile(tabId: string, deps: EditorFileDeps): Promise<FileOpResult> {
  const tab = findEditorFileTabById(useEditorStore.getState().tabs, tabId);
  if (!tab) return { ok: false, code: 'TAB_NOT_FOUND', message: `tab not found: ${tabId}` };
  let r: FsReadFileResult;
  try {
    r = await deps.fs.readFile(tab.filePath);
  } catch (err) {
    return exception(err);
  }
  if (!r.ok) return r;
  useEditorStore.getState().reloadFromDisk(tabId, r.data, r.realPath, { discardChanges: true });
  return { ok: true, data: undefined };
}

/**
 * 把编辑器回写的全文写入 tab。`base` 是编辑器最近一次上抛(或挂载时)的内容:store 里该 tab
 * 内容已不等于 base → 期间被别处改过(外部改盘 reloadFromDisk 触发 epoch 重挂载等),不用旧
 * 编辑器的内容覆盖。tab 已关闭 → no-op。
 */
export function applyEditorWriteBack(
  tabId: string,
  markdown: string,
  base: string,
): void {
  const store = useEditorStore;
  const cur = findEditorFileTabById(store.getState().tabs, tabId);
  if (!cur || cur.content !== base) return;
  store.getState().updateContent(tabId, markdown);
}
