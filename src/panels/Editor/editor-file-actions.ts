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
  getEffectiveMode,
  getUserActivationGen,
  useEditorStore,
} from '@/stores/editor.store';
import { runSerialPerKey } from '@/lib/serialize-per-key';
import {
  findEditorFileTabById,
  findEditorFileTabByPath,
} from './editor-tab-lookup';
import { isMarkdownPath } from './editor-path-utils';
import { recordSavedDiskStat } from './saved-disk-stat';
import {
  loadCodeEditorModule,
  loadEditorPanelModule,
  loadMilkdownEditorModule,
} from './editor-engine-loaders';

const ignoreWarmupError = (): void => {};

/**
 * perf:首次打开文件时与 readFile 并行预热即将渲染的编辑引擎 chunk(此前要等 readFile + openTab 提交后
 * EditorPanel 渲染 lazy 引擎才开始拉)。引擎选择与 EditorPanel 同口径:Markdown 且 getEffectiveMode 非 source
 * → Milkdown,否则 CodeEditor(读文件前无 tab,按 null tab 判定;unsafe 内容落 Source 时仅多拉一个 chunk)。
 * 共享 loader 去重、失败不缓存;fire-and-forget,失败吞掉(真正渲染时由引擎错误边界处理)。
 * 也供 Explorer 文件行 pointerdown 调用(意图早于 click,提前量更大)。
 */
export function warmEditorEngineFor(path: string): void {
  loadEditorPanelModule().catch(ignoreWarmupError);
  const engine =
    isMarkdownPath(path) && getEffectiveMode(null) !== 'source'
      ? loadMilkdownEditorModule()
      : loadCodeEditorModule();
  engine.catch(ignoreWarmupError);
}

// race(R21):同一 tab 的保存串行链。autosave(旧内容)在途时用户编辑 + 手动保存(新内容),若
// 二者乱序完成,旧内容会最后落盘覆盖新的。按 tabId 串行保证按发起顺序写盘,最后发起者最后落盘。
const saveChains = new Map<string, Promise<unknown>>();

export interface EditorFileDeps {
  fs: Pick<FsApi, 'readFile' | 'writeFile'>;
  /** 用注入便于 spec 复用同一全局 store. */
  store: typeof useEditorStore;
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
  const r = await openTabWith(path, deps, () => deps.fs.readFile(path));
  return r.ok ? OPENED : r;
}

const OPENED: FileOpResult = { ok: true, data: undefined };

/**
 * 安全(插件 editor.openFile):用主进程已校验并读出的内容开标签,不再经宿主受信通道按路径另读一次(见
 * src/__tests__/plugin-editor-open-verified/)。path 必须是主进程返回的 canonical 路径(不含链接,所以不带 realPath)。
 * 其余与 openFileByPath 相同:已开过 → 只切换(不覆盖已开标签的内容);用户激活代际;读后复检并发打开。
 * 新建的标签带 pluginOpenedPath 标记(不进会话快照,关闭时释放主进程记录)。data = 是否新建了标签。
 */
export function openFileWithContent(
  path: string,
  content: string,
  deps: Pick<EditorFileDeps, 'store'>,
): Promise<IpcResult<boolean>> {
  return openTabWith(path, deps, async () => ({ ok: true, data: content }), path);
}

/** data = 是否新建了标签(false:已开着只切换)。 */
async function openTabWith(
  path: string,
  deps: Pick<EditorFileDeps, 'store'>,
  read: () => Promise<IpcResult<string> & { readonly realPath?: string }>,
  pluginOpenedPath?: string,
): Promise<IpcResult<boolean>> {
  const { store } = deps;
  // 已开过 → 只切换。跨平台(codex 复查 P1):用平台感知 pathEquals 而非 `===` —— Windows
  // 上同一文件以 `C:\Repo\a.md` / `c:\repo\a.md` 不同大小写打开,`===` 判不等 → 开出两个
  // tab,分别编辑保存同一文件 → 后保存者覆盖前者丢改。switchTab 用**已存在 tab 的真实 id**
  // (大小写可能与传入 path 不同)。POSIX 大小写敏感不变(pathEquals 在非 Windows 即 ===)。
  const existing = findEditorFileTabByPath(store.getState().tabs, path);
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
  const raced = findEditorFileTabByPath(store.getState().tabs, path);
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
 * Cmd+S 触发。已存在 filePath 才能保存;无 path → UNSAVED_DRAFT(MVP 不支持另存为)。
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
): Promise<FileOpResult | null> {
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
    code: 'EDITOR_DISK_CHANGED',
    message: `file changed on disk since last load/save: ${filePath}`,
  };
}

async function saveFileNow(
  tabId: string,
  deps: EditorFileDeps,
  opts?: SaveFileOptions,
): Promise<FileOpResult> {
  const { fs, store } = deps;
  let tab = findEditorFileTabById(store.getState().tabs, tabId);
  if (opts?.force !== true && tab?.filePath) {
    const blocked = await checkDiskBeforeSave(fs, tab.filePath, tab.originalContent);
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
  if (!tab.filePath) {
    return {
      ok: false,
      code: 'UNSAVED_DRAFT',
      message: 'untitled draft cannot save without a path (MVP 不支持另存为)',
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
