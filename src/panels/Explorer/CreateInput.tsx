import { useEffect, useRef, useState } from 'react';
import { Document, Folder } from '@react-symbols/icons';

interface CreateInputProps {
  type: 'file' | 'dir';
  parentDir: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

const ICON_SIZE = 14;

// FolderTree 顶部 sticky input bar:新建文件 / 文件夹时显示。
// VSCode 真"行内"接入 react-virtual 复杂(伪 row 与虚拟列表序号互不知),
// MVP 折中:顶部条带 + 标注父目录 path,体感接近行内但实现简单。
export function CreateInput({
  type,
  parentDir,
  onSubmit,
  onCancel,
}: CreateInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-2 py-1 text-xs">
      <span className="inline-flex shrink-0" aria-hidden="true">
        {type === 'dir' ? (
          <Folder width={ICON_SIZE} height={ICON_SIZE} />
        ) : (
          <Document width={ICON_SIZE} height={ICON_SIZE} />
        )}
      </span>
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const t = value.trim();
            if (t) onSubmit(t);
            else onCancel();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
          e.stopPropagation();
          // 阻止原生事件冒泡到 headless-tree 容器(同 RenameInput)
          e.nativeEvent.stopPropagation();
        }}
        placeholder={type === 'dir' ? '新建文件夹名…' : '新建文件名…'}
        className="flex-1 rounded bg-neutral-800 px-2 py-0.5 text-neutral-100 outline-none ring-1 ring-sky-500 placeholder:text-neutral-500"
        spellCheck={false}
        autoComplete="off"
      />
      <span
        className="max-w-[40%] truncate text-[10px] text-neutral-500"
        title={parentDir}
      >
        在: {parentDir}
      </span>
      <button
        type="button"
        onClick={onCancel}
        className="rounded px-1 text-[10px] text-neutral-400 hover:text-neutral-200"
        title="取消(Esc)"
      >
        ✕
      </button>
    </div>
  );
}
