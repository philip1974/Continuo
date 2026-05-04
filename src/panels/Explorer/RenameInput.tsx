import { useEffect, useRef, useState } from 'react';

interface RenameInputProps {
  initialName: string;
  /** 提交时返回新名字;Enter 触发 */
  onSubmit: (newName: string) => void;
  /** Esc / blur 取消;父决定是否真的退出 rename 状态 */
  onCancel: () => void;
}

// 行内 rename input。挂载即聚焦,默认选中除扩展名外的部分(VSCode 行为)。
//
// 关键:Esc/Enter 必须用原生 capture-phase listener,
// 否则会被 headless-tree 的 hotkeys(树容器上的原生 bubble listener)先吃掉。
export function RenameInput({
  initialName,
  onSubmit,
  onCancel,
}: RenameInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialName);

  // 用 ref 存最新 callback,避免 useEffect 依赖变化重注册 listener
  const onSubmitRef = useRef(onSubmit);
  const onCancelRef = useRef(onCancel);
  onSubmitRef.current = onSubmit;
  onCancelRef.current = onCancel;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initialName.lastIndexOf('.');
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();

    // capture 阶段拦 Esc/Enter,先于 headless-tree 树容器 listener
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancelRef.current();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const trimmed = el.value.trim();
        if (trimmed && trimmed !== initialName) onSubmitRef.current(trimmed);
        else onCancelRef.current();
      }
    };
    el.addEventListener('keydown', handler, { capture: true });
    return () =>
      el.removeEventListener('keydown', handler, { capture: true });
  }, [initialName]);

  return (
    <input
      ref={ref}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={onCancel}
      onClick={(e) => e.stopPropagation()}
      className="w-full rounded bg-neutral-800 px-1 py-0 text-xs text-neutral-100 outline-none ring-1 ring-sky-500"
      spellCheck={false}
      autoComplete="off"
    />
  );
}
