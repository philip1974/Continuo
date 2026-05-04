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
//
// Esc/Enter 用原生 capture-phase listener,先于 headless-tree hotkeys 拦截
// (CreateInput 在树容器外,但 React 合成事件分发时机仍可能晚)。
export function CreateInput({
  type,
  parentDir,
  onSubmit,
  onCancel,
}: CreateInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');

  const onSubmitRef = useRef(onSubmit);
  const onCancelRef = useRef(onCancel);
  onSubmitRef.current = onSubmit;
  onCancelRef.current = onCancel;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // 延迟到下一帧 focus,让 Radix ContextMenu 的 focus restore 先跑完,
    // 否则我们 sync 调的 el.focus() 会被它 microtask 覆盖,active 又跑回 body。
    const rafId = requestAnimationFrame(() => el.focus());

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancelRef.current();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const t = el.value.trim();
        if (t) onSubmitRef.current(t);
        else onCancelRef.current();
      }
    };
    el.addEventListener('keydown', handler, { capture: true });
    return () => {
      cancelAnimationFrame(rafId);
      el.removeEventListener('keydown', handler, { capture: true });
    };
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
