import { useMemo, useRef } from 'react';
import { useTree } from '@headless-tree/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { FileEntry } from '@/lib/fs/types';
import { createTreeConfig } from './tree-config';
import { FILE_ROW_HEIGHT, FileRow } from './FileRow';

// useTree + react-virtual 渲染扁平的已展开节点列表。
// dataLoader 调 window.api.fs.listDir,IPC 失败 → tree-config 默认 console.warn。
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
    <div className="flex h-full w-full flex-col">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto bg-[#020617]"
      >
        {items.length === 0 ? (
          <div className="p-4 text-xs text-neutral-500">
            读取中或空目录(若一直这样,看顶部 err 信息或 DevTools)
          </div>
        ) : (
          // getContainerProps 必须绑在"含 tree children"的 inner div(返回 ARIA + 焦点 handlers),
          // 不绑在 scrollContainer 上,否则与 react-virtual 的尺寸测量互相干扰
          <div
            {...tree.getContainerProps()}
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
    </div>
  );
}
