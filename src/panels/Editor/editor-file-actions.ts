// M-Editor Step E2:文件操作纯函数。
// React hook(useEditorFile)是薄壳,业务逻辑都在这里,可单测。
//
// MVP 简化(详见 doc/09 § MVP 范围):
//  - 只实现 openFileByPath / saveFile
//  - 不做 Cmd+O / Cmd+N / 另存为(Continuo fs IPC 暂无 open/saveDialog 通道)
//  - 新建/打开文件统一走 Explorer 右键菜单 + 单击

import type { FsApi } from '@/lib/fs/api';
import type { IpcResult } from '@/lib/fs/types';
import { errorMessage } from '../../../electron/shared/error-message';
import { createTab, useEditorStore } from '@/stores/editor.store';
import { runSerialPerKey } from '@/lib/serialize-per-key';
import {
  findEditorFileTabById,
  findEditorFileTabByPath,
} from './editor-tab-lookup';

export { findEditorFileTabById, findEditorFileTabByPath } from './editor-tab-lookup';

// race(R21):同一 tab 的保存串行链。autosave(旧内容)在途时用户编辑 + 手动保存(新内容),若
// 二者乱序完成,旧内容会最后落盘覆盖新的。按 tabId 串行保证按发起顺序写盘,最后发起者最后落盘。
const saveChains = new Map<string, Promise<unknown>>();

export interface EditorFileDeps {
  fs: Pick<FsApi, 'readFile' | 'writeFile'>;
  /** 用注入便于 spec 复用同一全局 store. */
  store: typeof useEditorStore;
}

export type FileOpResult = IpcResult<void>;

const exception = (err: unknown): FileOpResult => ({
  ok: false,
  code: 'EXCEPTION',
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
  const { fs, store } = deps;
  // 已开过 → 只切换。跨平台(codex 复查 P1):用平台感知 pathEquals 而非 `===` —— Windows
  // 上同一文件以 `C:\Repo\a.md` / `c:\repo\a.md` 不同大小写打开,`===` 判不等 → 开出两个
  // tab,分别编辑保存同一文件 → 后保存者覆盖前者丢改。switchTab 用**已存在 tab 的真实 id**
  // (大小写可能与传入 path 不同)。POSIX 大小写敏感不变(pathEquals 在非 Windows 即 ===)。
  const existing = findEditorFileTabByPath(store.getState().tabs, path);
  if (existing) {
    store.getState().switchTab(existing.id);
    return { ok: true, data: undefined };
  }

  let r;
  try {
    r = await fs.readFile(path);
  } catch (err) {
    return exception(err);
  }
  if (!r.ok) return r;

  // race(R20):check(上面 existing)→ read → create 之间是 TOCTOU 窗口。并发打开同一文件
  // (尤其 Windows 不同大小写路径 C:\Repo\a.md / c:\repo\a.md)时,两个调用都在读前看不到
  // existing,读后各自 createTab → 同一磁盘文件出现两个 tab,分别保存互相覆盖(重现 X10
  // pathEquals 想防的数据丢失)。读后、建 tab 前再用 pathEquals 复检 store,已存在则只切换。
  const raced = findEditorFileTabByPath(store.getState().tabs, path);
  if (raced) {
    store.getState().switchTab(raced.id);
    return { ok: true, data: undefined };
  }

  store.getState().openTab(createTab(path, r.data));
  return { ok: true, data: undefined };
}

/**
 * Cmd+S 触发。已存在 filePath 才能保存;无 path → UNSAVED_DRAFT(MVP 不支持另存为)。
 * 成功后 store.markSaved。
 */
export async function saveFile(
  tabId: string,
  deps: EditorFileDeps,
): Promise<FileOpResult> {
  // race(R21):同 tab 的保存按发起顺序串行写盘 —— 防 autosave 旧内容晚于手动保存新内容落盘而
  // 覆盖。每次进链时重读 tab.content(在 task 内取快照),保证串行后写的是当时最新内容。
  return runSerialPerKey(saveChains, tabId, () => saveFileNow(tabId, deps));
}

async function saveFileNow(
  tabId: string,
  deps: EditorFileDeps,
): Promise<FileOpResult> {
  const { fs, store } = deps;
  const tab = findEditorFileTabById(store.getState().tabs, tabId);
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

  store.getState().markSaved(tabId, savedContent);
  return { ok: true, data: undefined };
}
