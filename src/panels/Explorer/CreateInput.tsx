import { useEffect, useId, useRef, useState } from 'react';
import { Document, Folder } from '@react-symbols/icons';
import { IconButton, Input } from '@/design';
import { useT } from '@/i18n';
import { createDirLabel, normalizeLeafNameInput } from './path-utils';
import { isImeComposing } from '@/design/ime';
import { FS_NAME_MAX } from '../../../electron/shared/leaf-name';

interface CreateInputProps {
  type: 'file' | 'dir';
  parentDir: string;
  /** 工作区根:传入时父目录显示为相对它的路径(根目录显示工作区名),完整路径放 title。 */
  rootPath?: string;
  /**
   * 提交名字。可返回 Promise<boolean>:结果为 false 表示创建失败 → 输入框保留已输入的名字,可改名重试;
   * 其它结果视为成功(父层随后卸载本输入)。trigger='blur':失焦触发的提交(焦点已在别处,失败时父层应直接放弃并
   * 告知原因,不留无焦点的错误输入条;VSCode 失焦时输入无效即取消)。
   */
  onSubmit: (name: string, trigger?: 'blur') => void | Promise<boolean>;
  /** 放弃新建。reason='blur':失焦放弃(焦点已在别处,父层不要再把焦点拉回树)。 */
  onCancel: (reason?: 'blur') => void;
  /** 上次提交失败的原因(已本地化),显示在输入框下方;修改输入时父层经 onEdit 清除。 */
  error?: string | null;
  /** 输入内容变化(父层据此清除 error)。 */
  onEdit?: () => void;
  /**
   * 实时校验(VSCode validateFileName,如同目录已存在同名项):返回已本地化的错误 → 输入框下方提示,Enter 不提交、
   * 失焦放弃;null = 有效。`error`(上次提交失败)存在时优先显示它。
   */
  validate?: (name: string) => string | null;
}

const ICON_SIZE = 14;

// FolderTree 顶部 sticky input bar:新建文件 / 文件夹时显示。
// VSCode 真"行内"接入 react-virtual 复杂(伪 row 与虚拟列表序号互不知),
// MVP 折中:顶部条带 + 标注父目录 path,体感接近行内但实现简单。
//
// Esc/Enter 用原生 capture-phase listener,先于 headless-tree hotkeys 拦截
// (CreateInput 在树容器外,但 React 合成事件分发时机仍可能晚)。
//
// 失焦(VSCode InlineEditInputBox 同款):焦点移到输入条之外 → 有可创建的名字且无错误提示(含实时校验)就提交,否则放弃。
// 失焦后等一个宏任务再判定(VSCode timeout(0)):焦点仍在输入条里(点了 ✕ / 窗口失焦后 activeElement 仍是输入框)→ 继续编辑。
// 每次新建由父层换 key 重挂载本组件(见 FolderTree creating.seq)→ 挂载即聚焦,不会出现「输入条开着但焦点不在」再新建时落空。
export function CreateInput({
  type,
  parentDir,
  rootPath,
  onSubmit,
  onCancel,
  error,
  onEdit,
  validate,
}: CreateInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const tx = useT();
  const errorId = useId();

  const onSubmitRef = useRef(onSubmit);
  const onCancelRef = useRef(onCancel);
  onSubmitRef.current = onSubmit;
  onCancelRef.current = onCancel;
  // race(R82):同步 once 守卫。父层 submitCreate 的 setCreating(null)(卸载本输入)要等 React
  // commit,期间快速双 Enter 会在同一挂载实例里两次调 onSubmit → 并发两次 createFile/createDir
  // IPC:第一笔成功、第二笔通常 EEXIST 失败弹错 → 用户见「创建成功却报错」。首次提交即置位,
  // 后续 Enter 忽略(ref 同步生效,不依赖 React state commit)。创建失败(onSubmit 结果为 false)时复位,
  // 用户改名后可重试。
  const submittedRef = useRef(false);
  // 已经 Esc / 空名 Enter 放弃(父层随后卸载):之后的失焦不再处理。
  const finishedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef(error);
  errorRef.current = error;
  const validateRef = useRef(validate);
  validateRef.current = validate;
  const shownError = error || validate?.(value) || null;

  const submit = (raw: string, trigger?: 'blur'): boolean => {
    const t = normalizeLeafNameInput(raw);
    if (t === null) return false;
    submittedRef.current = true;
    const result = trigger === undefined ? onSubmitRef.current(t) : onSubmitRef.current(t, trigger);
    if (result) {
      void result.then((ok) => {
        if (ok === false) submittedRef.current = false;
      });
    }
    return true;
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let disposed = false;

    // 延迟到下一帧 focus,让 Radix ContextMenu 的 focus restore 先跑完,
    // 否则我们 sync 调的 el.focus() 会被它 microtask 覆盖,active 又跑回 body。
    const rafId = requestAnimationFrame(() => el.focus());

    const handler = (e: KeyboardEvent) => {
      // IME 组合中的 Enter / Esc 属于输入法(确认候选 / 取消组合),不提交也不取消新建。
      if (isImeComposing(e)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finishedRef.current = true;
        onCancelRef.current();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (submittedRef.current) return; // race(R82):已提交,忽略重复 Enter
        if (validateRef.current?.(el.value)) return; // 实时校验未通过(如重名):不提交,输入保留(VSCode)
        if (!submitRef.current(el.value)) {
          finishedRef.current = true;
          onCancelRef.current();
        }
      }
    };
    const onBlur = () => {
      setTimeout(() => {
        if (disposed || finishedRef.current || submittedRef.current) return;
        const active = el.ownerDocument.activeElement;
        if (active && rootRef.current?.contains(active)) return; // 仍在输入条里(✕ 按钮 / 窗口失焦)
        // 上次提交失败(错误提示还在)或实时校验未通过 = 输入无效 → 放弃(VSCode:无效输入失焦即取消)
        if (!errorRef.current && !validateRef.current?.(el.value) && submitRef.current(el.value, 'blur')) return;
        finishedRef.current = true;
        onCancelRef.current('blur');
      }, 0);
    };
    el.addEventListener('keydown', handler, { capture: true });
    el.addEventListener('blur', onBlur);
    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      el.removeEventListener('keydown', handler, { capture: true });
      el.removeEventListener('blur', onBlur);
    };
  }, []);

  return (
    <div ref={rootRef} className="shrink-0 border-b border-line bg-panel-soft px-2 py-1 text-xs">
      <div className="flex items-center gap-2">
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
          // 到 main 才失败。>FS_NAME_MAX 的名在任何文件系统都 ENAMETOOLONG 建不出,
          // 截断不丢任何可创建的名。maxLength 作原生兜底(键入/paste 双拦)。
          onChange={(e) => {
            setValue(e.target.value.slice(0, FS_NAME_MAX));
            onEdit?.();
          }}
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
          aria-invalid={shownError ? true : undefined}
          aria-describedby={shownError ? errorId : undefined}
        />
        <span
          className="max-w-[40%] truncate text-2xs text-fg-dim"
          title={parentDir}
        >
          {tx('panels.explorer.create.in_label', {
            dir: rootPath === undefined ? parentDir : createDirLabel(rootPath, parentDir),
          })}
        </span>
        <IconButton
          size="xs"
          onClick={() => {
            finishedRef.current = true;
            onCancel();
          }}
          title={tx('panels.explorer.confirm.cancel_esc')}
          aria-label={tx('panels.explorer.confirm.cancel')}
        >
          ✕
        </IconButton>
      </div>
      {/* 创建失败原因(VSCode 同款:输入框下方内联提示,不关输入框)。role=alert 让读屏即时播报。 */}
      {shownError && (
        <div id={errorId} role="alert" className="mt-1 break-words text-2xs text-error">
          {shownError}
        </div>
      )}
    </div>
  );
}
