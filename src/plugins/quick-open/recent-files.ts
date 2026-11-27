// Quick Open「最近打开」(VSCode:空查询先列编辑器历史 —— HistoryService 按工作区持久化,跨重启保留)。
//
// localStorage key=continuo:quick-open:recent,形态 [{ root, paths }](最近用的工作区在前,各自最近打开的文件在前)。
// 记录点:编辑器的「用户激活」—— 打开 / 切换文件都递增 editorFocusPulse(会话恢复不递增),此时记活动 tab 的路径;
// 只记当前工作区内的文件。文件改名 / 移动(editor.store 路径变更通知)→ 旧路径(含目录前缀)原位改写为新路径
// (VSCode HistoryService.moveInHistory);删除 → 移除。读写都 try/catch(隐私模式 / 配额 / 篡改),读回逐项校验、有界迭代。
//
// BDD: src/__tests__/quick-open-recent/

import { clearStoredKey, readStoredJson } from '../storage/local-storage-record';
import { isSameOrInsidePath, pathEquals } from '@/lib/path-cross';
import { onEditorPathChange, rewriteMovedPath, useEditorStore } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { PATH_STR_MAX } from '../../../electron/shared/explorer-persistence-schema';

export const RECENT_FILES_STORAGE_KEY = 'continuo:quick-open:recent';
/** 每个工作区记的文件数上限。 */
export const MAX_RECENT_FILES = 50;
/** 记的工作区数上限(最久未用的先淘汰)。 */
export const MAX_RECENT_FILE_ROOTS = 20;
// 解析前的原始串上限(超限 = 篡改 / 残留 → 清掉);写入超限时淘汰最旧的工作区。
const MAX_RAW_LENGTH = 1024 * 1024;

interface RootEntry {
  readonly root: string;
  readonly paths: readonly string[];
}

const isPath = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= PATH_STR_MAX;

function readAll(): RootEntry[] {
  const parsed = readStoredJson(RECENT_FILES_STORAGE_KEY, MAX_RAW_LENGTH);
  if (parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    clearStoredKey(RECENT_FILES_STORAGE_KEY);
    return [];
  }
  const out: RootEntry[] = [];
  for (const item of parsed) {
    if (out.length >= MAX_RECENT_FILE_ROOTS) break;
    if (!item || typeof item !== 'object') continue;
    const { root, paths } = item as { root?: unknown; paths?: unknown };
    if (!isPath(root) || !Array.isArray(paths)) continue;
    const valid: string[] = [];
    for (const p of paths) {
      if (valid.length >= MAX_RECENT_FILES) break;
      if (isPath(p)) valid.push(p);
    }
    out.push({ root, paths: valid });
  }
  return out;
}

function writeAll(entries: RootEntry[]): void {
  try {
    let list = entries;
    let raw = JSON.stringify(list);
    while (raw.length > MAX_RAW_LENGTH && list.length > 1) {
      list = list.slice(0, -1);
      raw = JSON.stringify(list);
    }
    if (raw.length <= MAX_RAW_LENGTH) localStorage.setItem(RECENT_FILES_STORAGE_KEY, raw);
  } catch {
    /* 配额 / 隐私模式 / 不可用 → 静默(只是少了最近记录) */
  }
}

/** 该工作区最近打开的文件(最近在前)。 */
export function recentFilesFor(root: string): readonly string[] {
  return readAll().find((e) => pathEquals(e.root, root))?.paths ?? [];
}

/** 把文件置顶到该工作区的最近列表(读 live 存储合并,多窗口各自记录不互相覆盖)。 */
export function recordRecentFile(root: string, path: string): void {
  if (!isPath(root) || !isPath(path)) return;
  const all = readAll();
  const idx = all.findIndex((e) => pathEquals(e.root, root));
  const prev = idx >= 0 ? all[idx]!.paths : [];
  if (prev[0] === path && idx === 0) return;
  const paths = [path, ...prev.filter((p) => p !== path)].slice(0, MAX_RECENT_FILES);
  const rest = all.filter((_, i) => i !== idx);
  writeAll([{ root, paths }, ...rest].slice(0, MAX_RECENT_FILE_ROOTS));
}

/**
 * 空查询的列表顺序:仍在扫描结果里的最近文件(按最近顺序)在前,其余按原顺序。recentCount = 前面最近项的个数。
 * 有查询时同样用此顺序喂给模糊匹配(稳定排序 → 同分时最近项优先,VSCode 历史加权的简化)。
 */
export function orderByRecent<T extends { readonly absPath: string }>(
  files: readonly T[],
  recent: readonly string[],
): { readonly items: readonly T[]; readonly recentCount: number } {
  if (recent.length === 0 || files.length === 0) return { items: files, recentCount: 0 };
  const byPath = new Map<string, T>();
  // NFC 兜底索引:同一文件经 NFC 路径打开(终端链接 / 手输路径;macOS 上与磁盘 NFD 名指向同一文件)时 tab 记下的路径与
  // 扫描到的磁盘原样路径码元不同,只按原样查会让这条最近项丢失。原样命中优先。
  const byNfc = new Map<string, T>();
  for (const f of files) {
    byPath.set(f.absPath, f);
    const nfc = f.absPath.normalize('NFC');
    if (!byNfc.has(nfc)) byNfc.set(nfc, f);
  }
  const head: T[] = [];
  const picked = new Set<T>();
  for (const p of recent) {
    const f = byPath.get(p) ?? byNfc.get(p.normalize('NFC'));
    if (f && !picked.has(f)) {
      head.push(f);
      picked.add(f);
    }
  }
  if (head.length === 0) return { items: files, recentCount: 0 };
  const items = head.slice();
  for (const f of files) if (!picked.has(f)) items.push(f);
  return { items, recentCount: head.length };
}

// 用户激活编辑器 tab(打开 / 切换)→ 记录。
useEditorStore.subscribe((s, prev) => {
  if (s.editorFocusPulse === prev.editorFocusPulse || s.activeTabId === null) return;
  const root = useWorkspaceStore.getState().root;
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  if (!root || !tab || !isSameOrInsidePath(root, tab.filePath)) return;
  recordRecentFile(root, tab.filePath);
});

/** 所有工作区的最近列表按 map 改写(null = 移除;顺序不变、去重保留靠前的);无变化不写。 */
function rewriteRecentFiles(map: (path: string) => string | null): void {
  const all = readAll();
  let changed = false;
  const next = all.map((e) => {
    const paths: string[] = [];
    for (const p of e.paths) {
      const np = map(p);
      if (np !== p) changed = true;
      if (np !== null && isPath(np) && isSameOrInsidePath(e.root, np) && !paths.includes(np)) paths.push(np);
    }
    return { root: e.root, paths };
  });
  if (changed) writeAll(next);
}

// 改名 / 移动 / 删除 → 最近记录跟随(否则改名后的文件从「最近打开」消失,要再激活一次 tab 才回来)。
onEditorPathChange((c) => {
  if (c.kind === 'moved') rewriteRecentFiles((p) => rewriteMovedPath(p, c.oldPath, c.newPath) ?? p);
  else rewriteRecentFiles((p) => (c.paths.some((r) => isSameOrInsidePath(r, p)) ? null : p));
});
