import { useEffect, useRef, useState } from 'react';

interface RenameInputProps {
  initialName: string;
  /** 提交时返回新名字;Enter 触发 */
  onSubmit: (newName: string) => void;
  /** Esc / blur 取消;父决定是否真的退出 rename 状态 */
  onCancel: () => void;
}

// 行内 rename input。挂载即聚焦,默认选中除扩展名外的部分(VSCode 行为)。
export function RenameInput({
  initialName,
  onSubmit,
  onCancel,
}: RenameInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialName);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // 选中文件名(不含扩展名)
    const dot = initialName.lastIndexOf('.');
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [initialName]);

  return (
    <input
      ref={ref}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const trimmed = value.trim();
          if (trimmed && trimmed !== initialName) onSubmit(trimmed);
          else onCancel();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
        e.stopPropagation();
        // 阻止原生事件冒泡到 headless-tree 容器(它用原生 addEventListener 监听 hotkeys,
        // React 合成事件的 stopPropagation 拦不住,会被吃掉 Esc)
        e.nativeEvent.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
      className="w-full rounded bg-neutral-800 px-1 py-0 text-xs text-neutral-100 outline-none ring-1 ring-sky-500"
      spellCheck={false}
      autoComplete="off"
    />
  );
}
