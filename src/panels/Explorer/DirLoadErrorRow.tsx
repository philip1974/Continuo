// 子目录读取失败的内联错误行(VSCode Explorer:展开失败的目录下显示错误行)。与根目录读取失败同一文案
// (panels.explorer.load_failed + 按错误码本地化的原因)与同一「重试」;作为虚拟列表里的一行插在失败目录之后。
import type { ItemInstance } from '@headless-tree/core';
import { Button } from '@/design';
import type { FileEntry } from '@/lib/fs/types';
import { useT } from '@/i18n';
import { localizeErrorByCode } from '@/lib/localize-error';

export interface DirLoadFailure {
  readonly code: string;
  readonly message: string;
}

export interface DirLoadErrorRowData {
  readonly kind: 'dir-load-error';
  readonly dir: string;
  /** 缩进层级 = 失败目录层级 + 1(与其子项对齐)。 */
  readonly level: number;
  readonly failure: DirLoadFailure;
}

export type TreeRow = ItemInstance<FileEntry> | DirLoadErrorRowData;

/** 两行高:原因 + 重试按钮。 */
export const DIR_LOAD_ERROR_ROW_HEIGHT = 56;

export function isDirLoadErrorRow(row: TreeRow | undefined): row is DirLoadErrorRowData {
  return row !== undefined && (row as DirLoadErrorRowData).kind === 'dir-load-error';
}

/**
 * 在读取失败且展开着的目录之后插入错误行。没有失败目录时原样返回 items(同一引用)。
 * 失败目录的子项缓存为空(loader 失败返回 []),故错误行紧跟目录行。
 */
export function insertDirLoadErrorRows(
  items: readonly ItemInstance<FileEntry>[],
  dirErrors: ReadonlyMap<string, DirLoadFailure>,
): readonly TreeRow[] {
  if (dirErrors.size === 0) return items;
  let rows: TreeRow[] | null = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const failure = dirErrors.get(item.getId());
    if (failure !== undefined && item.isFolder() && item.isExpanded()) {
      rows ??= items.slice(0, i);
      rows.push(item, {
        kind: 'dir-load-error',
        dir: item.getId(),
        level: item.getItemMeta().level + 1,
        failure,
      });
    } else if (rows !== null) {
      rows.push(item);
    }
  }
  return rows ?? items;
}

interface DirLoadErrorRowProps {
  readonly row: DirLoadErrorRowData;
  /** react-virtual 行起点(px)。 */
  readonly start: number;
  readonly indent: number;
  readonly onRetry: (dir: string) => void;
}

export function DirLoadErrorRow({ row, start, indent, onRetry }: DirLoadErrorRowProps) {
  const t = useT();
  const text = t('panels.explorer.load_failed', {
    message: localizeErrorByCode(row.failure.code, row.failure.message),
  });
  return (
    <div
      // 树容器(role=tree)里的非 treeitem 行:不参与树的方向键导航,「重试」可用 Tab 到达。
      role="none"
      className="flex flex-col items-start justify-center gap-1 text-2xs"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        transform: `translateY(${start}px)`,
        height: DIR_LOAD_ERROR_ROW_HEIGHT,
        // 与子项名称对齐:行左 padding(4)+ 层级缩进 + 箭头列(12)与间距(4)
        paddingLeft: 4 + row.level * indent + 16,
        paddingRight: 8,
      }}
    >
      <div role="alert" className="w-full truncate text-error" title={text}>
        {text}
      </div>
      <Button variant="outlined" size="sm" onClick={() => onRetry(row.dir)}>
        {t('panels.explorer.retry')}
      </Button>
    </div>
  );
}
