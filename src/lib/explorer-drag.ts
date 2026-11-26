// 从资源管理器树拖出的数据(对齐 VSCode fillEditorsDragData + explorer onDragStart;BDD: src/__tests__/explorer-drag-out/):
// - 自定义 MIME(EXPLORER_DRAG_MIME):[{ path, isDirectory }] JSON —— 应用内接收端(编辑器组 / 终端)优先读它;
// - text/uri-list:file:// URL(每行一个,RFC 2483 CRLF 分隔)—— 拖到应用外;
// - text/plain:绝对路径,换行分隔 —— 拖到文本框等(VSCode DataTransfers.TEXT)。
// 不放 'Files':那是 OS 文件拖放(Finder),树 / 终端 / 窗口的既有 OS drop 逻辑都按它判断,树内拖出不能被当成它。

import { MAX_DROP_FILES } from './window-drop';

export const EXPLORER_DRAG_MIME = 'application/x-continuo-paths';

export interface ExplorerDragEntry {
  readonly path: string;
  readonly isDirectory: boolean;
}

/** 绝对路径 → file:// URL(POSIX `/a b` → `file:///a%20b`;Windows `C:\a` → `file:///C:/a`;UNC `\\srv\s` → `file://srv/s`)。 */
export function fileUrlOf(path: string): string {
  const p = path.replace(/\\/g, '/');
  const body = p
    .split('/')
    .map((seg) => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/');
  if (p.startsWith('//')) return `file:${body}`;
  return `file://${body.startsWith('/') ? body : `/${body}`}`;
}

/** dragstart 时写入拖动数据(只在 dragstart 回调里同步调用才生效)。 */
export function setExplorerDragData(dataTransfer: DataTransfer, entries: readonly ExplorerDragEntry[]): void {
  if (entries.length === 0) return;
  const payload = entries.map(({ path, isDirectory }) => ({ path, isDirectory }));
  dataTransfer.setData(EXPLORER_DRAG_MIME, JSON.stringify(payload));
  dataTransfer.setData('text/uri-list', entries.map((e) => fileUrlOf(e.path)).join('\r\n'));
  dataTransfer.setData('text/plain', entries.map((e) => e.path).join('\n'));
}

/** dragenter / dragover 期间可判(此时读不到数据,只看得到类型)。按索引早停,不物化 types。 */
export function hasExplorerDrag(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false;
  const types = dataTransfer.types;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === EXPLORER_DRAG_MIME) return true;
  }
  return false;
}

export interface ExplorerDragData {
  /** 合法条目,最多 max 个。 */
  readonly entries: readonly ExplorerDragEntry[];
  /** 超过 max 未取的条目数。 */
  readonly overflow: number;
}

/**
 * drop 时读拖动数据(只在 drop 回调里同步可读)。没有 / 不是合法 JSON 数组 → null;非法元素丢弃。
 * 边界(E114 同族):最多取 max 个(缺省 MAX_DROP_FILES),其余计入 overflow。
 */
export function readExplorerDragData(
  dataTransfer: DataTransfer | null | undefined,
  max: number = MAX_DROP_FILES,
): ExplorerDragData | null {
  if (!hasExplorerDrag(dataTransfer)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(dataTransfer!.getData(EXPLORER_DRAG_MIME));
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const entries: ExplorerDragEntry[] = [];
  let overflow = 0;
  for (const item of raw as unknown[]) {
    if (item === null || typeof item !== 'object') continue;
    const { path, isDirectory } = item as { path?: unknown; isDirectory?: unknown };
    if (typeof path !== 'string' || path.length === 0) continue;
    if (entries.length >= max) {
      overflow += 1;
      continue;
    }
    entries.push({ path, isDirectory: isDirectory === true });
  }
  return { entries, overflow };
}
