import { useEffect, useRef, useState } from 'react';
import { Document, Folder } from '@react-symbols/icons';
import { IconButton, Input } from '@/design';
import { useT } from '@/i18n';
import { FS_NAME_MAX } from '../../../electron/shared/leaf-name';

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
  const tx = useT();

  const onSubmitRef = useRef(onSubmit);
  const onCancelRef = useRef(onCancel);
  onSubmitRef.current = onSubmit;
  onCancelRef.current = onCancel;
  // race(R82):同步 once 守卫。父层 submitCreate 的 setCreating(null)(卸载本输入)要等 React
  // commit,期间快速双 Enter 会在同一挂载实例里两次调 onSubmit → 并发两次 createFile/createDir
  // IPC:第一笔成功、第二笔通常 EEXIST 失败弹错 → 用户见「创建成功却报错」。首次提交即置位,
  // 后续 Enter 忽略(ref 同步生效,不依赖 React state commit)。
  const submittedRef = useRef(false);

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
        if (submittedRef.current) return; // race(R82):已提交,忽略重复 Enter
        const t = el.value.trim();
        if (t) {
          submittedRef.current = true;
          onSubmitRef.current(t);
        } else {
          onCancelRef.current();
        }
      }
    };
    el.addEventListener('keydown', handler, { capture: true });
    return () => {
      cancelAnimationFrame(rafId);
      el.removeEventListener('keydown', handler, { capture: true });
    };
  }, []);

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel-soft px-2 py-1 text-xs">
      <span className="inline-flex shrink-0" aria-hidden="true">
        {type === 'dir' ? (
          <Folder width={ICON_SIZE} height={ICON_SIZE} />
        ) : (
          <Document width={ICON_SIZE} height={ICON_SIZE} />
        )}
      </span>
      <Input
        ref={ref}
        size="sm"
        type="text"
        value={value}
        // 边界(E290,E279-E282 before-IPC 输入截断族):leaf 名 onChange 截断到 FS_NAME_MAX。
        // 超长 paste 否则整段进受控 React state(巨值 controlled input 反复 re-render)+ Enter 后跨 IPC
        // 到 main 才被 leafNameRejectReason 拒。>FS_NAME_MAX 的名在任何文件系统都 ENAMETOOLONG 建不出,
        // 截断不丢任何可创建的名。maxLength 作原生兜底(键入/paste 双拦)。
        onChange={(e) => setValue(e.target.value.slice(0, FS_NAME_MAX))}
        maxLength={FS_NAME_MAX}
        // a11y(A5 同族):placeholder 本身是标签(新建文件夹/文件名)→ 同值复用作 aria-label。
        aria-label={
          type === 'dir'
            ? tx('panels.explorer.placeholder.new_folder')
            : tx('panels.explorer.placeholder.new_file')
        }
        placeholder={
          type === 'dir'
            ? tx('panels.explorer.placeholder.new_folder')
            : tx('panels.explorer.placeholder.new_file')
        }
        className="flex-1"
        spellCheck={false}
        autoComplete="off"
      />
      <span
        className="max-w-[40%] truncate text-2xs text-fg-dim"
        title={parentDir}
      >
        {tx('panels.explorer.create.in_label', { dir: parentDir })}
      </span>
      <IconButton
        size="xs"
        onClick={onCancel}
        title={tx('panels.explorer.confirm.cancel_esc')}
        aria-label={tx('panels.explorer.confirm.cancel')}
      >
        ✕
      </IconButton>
    </div>
  );
}
