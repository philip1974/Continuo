// 另存为(VSCode workbench.action.files.saveAs,⇧⌘S / Ctrl+Shift+S;无标题文件的 ⌘S 同样走这里)。
// 1. 编辑器里尚未上抛的输入先写回 store;
// 2. 主进程弹原生保存对话框(fs:show-save-dialog,只返回路径;覆盖已有文件由系统对话框确认)。默认位置:已有文件 = 它自己的路径;
//    无标题文件 = 工作区根(无工作区 → 主目录)下按首行推断的名字;
// 3. 选定路径写盘仍走 fs:write-file(原地写 / 符号链接写穿 / 插件打开路径守卫同普通保存;不比对磁盘 —— 覆盖已经确认过);
// 4. 成功 → 原 tab 换到新路径(retargetTab:不留两个 tab,各组同位置,视图状态 / 撤销历史随迁;已开着的目标 tab 关闭),
//    基线 = 写入的内容(写盘期间继续输入仍脏),导航历史里的旧条目改指新路径。原文件不动。
//    编码沿用 tab 当前的(UTF-16 LE / BE / UTF-8 BOM 带 BOM,GBK 等按该编码;行尾就在内容里,原样写),新路径的 tab 保留这个编码;
//    文本含该编码表示不了的字符 → FS_UNENCODABLE,不写、tab 不变(同普通保存)。
// 选同一路径 = 普通保存(跳过磁盘比对)。取消 → data: null,什么都不改。失败 → 原样返回,tab 不变。
// 同一 tab 的另存为与保存共用 saveFile 的串行链之外的单飞闸:对话框开着时再按 ⇧⌘S 不叠第二个对话框。
// BDD: src/__tests__/editor-save-as/
import type { IpcResult } from '@/lib/fs/types';
import type { FsFileStat } from '../../../electron/shared/fs-channels';
import { errorCodeOf, errorMessage } from '../../../electron/shared/error-message';
import { joinPath, pathEquals } from '@/lib/path-cross';
import { useEditorStore } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { findEditorFileTabById } from './editor-tab-lookup';
import { flushEditorWriteBacks } from './editor-writeback-registry';
import { recordSavedDiskStat } from './saved-disk-stat';
import { retargetNavigationHistory } from './navigation-history';
import { isUntitledPath, suggestedUntitledFileName } from './untitled';
import { tabEncodingOf } from './editor-encoding';
import type { TextEncodingId } from '../../../electron/shared/text-encoding';

export interface SaveAsDeps {
  readonly showSaveDialog: (defaultPath: string) => Promise<IpcResult<string | null>>;
  readonly writeFile: (
    path: string,
    content: string,
    opts?: { readonly encoding: TextEncodingId },
  ) => Promise<IpcResult<FsFileStat | undefined>>;
}

/** data = 保存到的路径;null = 用户取消。 */
export type SaveAsResult = IpcResult<string | null>;

const inFlight = new Set<string>();

const failure = (err: unknown): SaveAsResult => ({ ok: false, code: errorCodeOf(err), message: errorMessage(err) });

/** 另存为对话框的默认位置(见文件头)。 */
export function saveAsDefaultPath(filePath: string, content: string, root: string | null): string {
  if (!isUntitledPath(filePath)) return filePath;
  const name = suggestedUntitledFileName(filePath, content);
  return root === null ? name : joinPath(root, name);
}

export async function saveTabAs(tabId: string, deps: SaveAsDeps): Promise<SaveAsResult> {
  if (inFlight.has(tabId)) return { ok: true, data: null };
  inFlight.add(tabId);
  try {
    return await saveTabAsNow(tabId, deps);
  } finally {
    inFlight.delete(tabId);
  }
}

async function saveTabAsNow(tabId: string, deps: SaveAsDeps): Promise<SaveAsResult> {
  flushEditorWriteBacks([tabId]);
  const store = useEditorStore;
  const before = findEditorFileTabById(store.getState().tabs, tabId);
  if (!before) return { ok: false, code: 'TAB_NOT_FOUND', message: `tab not found: ${tabId}` };
  let picked: string | null;
  try {
    const r = await deps.showSaveDialog(
      saveAsDefaultPath(before.filePath, before.content, useWorkspaceStore.getState().root),
    );
    if (!r.ok) return r;
    picked = r.data;
  } catch (err) {
    return failure(err);
  }
  if (picked === null) return { ok: true, data: null };
  // 对话框期间(非模态平台)的输入同样写回;tab 已被关 → 不写
  flushEditorWriteBacks([tabId]);
  const tab = findEditorFileTabById(store.getState().tabs, tabId);
  if (!tab) return { ok: false, code: 'TAB_NOT_FOUND', message: `tab not found: ${tabId}` };
  const content = tab.content;
  // utf8 不带 encoding(写入载荷与普通保存同口径,见 saveFileNow)
  const encoding = tabEncodingOf(tab);
  let w: IpcResult<FsFileStat | undefined>;
  try {
    w = await (encoding === 'utf8' ? deps.writeFile(picked, content) : deps.writeFile(picked, content, { encoding }));
  } catch (err) {
    return failure(err);
  }
  if (!w.ok) return w;
  // 写盘期间 tab 被关 → 文件已写好,不再建 tab(VSCode 同:关掉的编辑器不复活)
  if (!findEditorFileTabById(store.getState().tabs, tabId)) return { ok: true, data: picked };
  // 选的就是原路径(大小写不敏感平台上大小写不同也算)→ 原 tab 不换 id
  const target = !isUntitledPath(tabId) && pathEquals(tabId, picked) ? tabId : picked;
  if (target !== tabId) {
    retargetNavigationHistory(tabId, target);
    store.getState().retargetTab(tabId, target);
  }
  const savedGen = recordSavedDiskStat(target, w.data);
  store.getState().markSaved(target, content, savedGen);
  return { ok: true, data: target };
}
