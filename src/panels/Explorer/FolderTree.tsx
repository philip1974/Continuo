import { useMemo, useRef } from 'react';
import { useTree } from '@headless-tree/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { FileEntry } from '@/lib/fs/types';
import { createTreeConfig } from './tree-config';
import { FILE_ROW_HEIGHT, FileRow } from './FileRow';

// useTree + react-virtual 渲染扁平的已展开节点列表。
// dataLoader 调 window.api.fs.listDir,IpcFail → console.warn(由 tree-config 默认行为)。
export function FolderTree({ root }: { root: string }) {
  const config = useMemo(
    () => createTreeConfig({ root, fs: window.api.fs }),
    [root],
  );
  const tree = useTree<FileEntry>(config);

  const items = tree.getItems();
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => FILE_ROW_HEIGHT,
    overscan: 8,
  });

  return (
    <div
      ref={scrollRef}
      {...tree.getContainerProps()}
      className="h-full w-full overflow-auto bg-[#020617]"
    >
      {items.length === 0 ? (
        <div className="p-4 text-xs text-neutral-500">读取中…(空目录或权限问题)</div>
      ) : (
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((vRow) => {
            const item = items[vRow.index];
            if (!item) return null;
            return (
              <FileRow
                key={item.getId()}
                item={item}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vRow.start}px)`,
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
