// 子目录读取失败的内联错误行(VSCode Explorer:展开失败的目录下显示错误行)。与根目录读取失败同一文案
// (panels.explorer.load_failed + 按错误码本地化的原因)与同一「重试」;作为虚拟列表里的一行插在失败目录之后。
import type { ItemInstance } from '@headless-tree/core';
import { useLayoutEffect, useRef } from 'react';
import { Button } from '@/design';
import type { FileEntry } from '@/lib/fs/types';
import { useT } from '@/i18n';
import { localizeErrorByCode } from '@/lib/localize-error';
import { TREE_ITEM_PLAIN_KEYS } from './tree-keyboard';

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
  const ref = useRef<HTMLDivElement>(null);
  // headless-tree 的 hotkeys 在树容器上原生监听 keydown,对「焦点项」执行(Enter / ← 收起、→ 展开、F2 改名、
  // ↑↓ Home End 移焦点 …),不看按键来自哪里 →「重试」上的这些树键(TREE_ITEM_PLAIN_KEYS)在本行截住,不冒泡到
  // 树容器;其它无修饰键(F5 等用户自绑的单键全局命令)照常冒泡。按钮自身的 Enter / 空格激活是默认动作,不受影响;
  // 带 ⌘ / Ctrl / Alt 的组合键照常冒泡到全局命令热键(树自己的 ⌘C 等由 handleTreeKeyDown 按来源过滤)。
  // layout effect:提交时就挂上。passive effect 要等之后的调度任务,主线程繁忙时行已显示、「重试」已可聚焦,
  // 这期间按的树键会漏到树容器(Enter / ← 把失败目录收起)。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey && !e.altKey && TREE_ITEM_PLAIN_KEYS.has(e.key)) e.stopPropagation();
    };
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, []);
  const text = t('panels.explorer.load_failed', {
    message: localizeErrorByCode(row.failure.code, row.failure.message),
  });
  return (
    <div
      ref={ref}
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
      {/* 普通文本:失败时已由 FolderTree 的常驻 live region 播报一次;本行随虚拟滚动 / 收起展开反复挂载,不能是 alert */}
      <div className="w-full truncate text-error" title={text}>
        {text}
      </div>
      <Button variant="outlined" size="sm" onClick={() => onRetry(row.dir)}>
        {t('panels.explorer.retry')}
      </Button>
    </div>
  );
}
