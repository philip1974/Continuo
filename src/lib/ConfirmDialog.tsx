import { useId } from 'react';
import { Button, Modal } from '@/design';
import { useT } from '@/i18n';
import { useStableCallback } from '@/lib/use-stable-callback';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /**
   * 初始焦点(回车 / 空格默认执行哪个)。缺省:非 destructive → 确认,destructive → 取消。
   * 'confirm' 只给**可恢复**的破坏性操作(移到废纸篓,对齐 VSCode 删除确认的主按钮默认):回车即执行;
   * 永久删除、覆盖写盘等不可恢复的确认不要传,保持聚焦取消。
   */
  defaultAction?: 'confirm' | 'cancel';
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * 可选第三按钮(如关闭脏文件的「保存 / 不保存 / 取消」里的「不保存」),排在取消左侧、ghost 样式;
   * alternativeLabel 与 onAlternative 都给才渲染。不参与初始焦点(仍按 defaultAction 落在确认或取消)。
   */
  alternativeLabel?: string;
  onAlternative?: () => void;
  /**
   * 可选的更多按钮,依次排在 alternative 左侧、ghost 样式(如保存冲突的「比较」:[比较, 放弃更改并重新加载, 取消, 覆盖])。
   * 同样不参与初始焦点。
   */
  extraActions?: readonly { readonly label: string; readonly onClick: () => void }[];
}

// 通用确认对话框(design Modal):编辑器关闭 / 覆盖确认、插件卸载、状态栏撤销授权、Explorer 删除确认共用(原在 panels/Explorer 下,
// 已移到 lib 供各处复用)。
// design Modal 自带 ESC + overlay 点击 → onClose,这里把 onClose 接到 onCancel。
export function ConfirmDialog({
  open,
  ...props
}: ConfirmDialogProps) {
  if (!open) return null;
  return <ConfirmDialogBody {...props} />;
}

function ConfirmDialogBody({
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = false,
  defaultAction = destructive ? 'cancel' : 'confirm',
  onConfirm,
  onCancel,
  alternativeLabel,
  onAlternative,
  extraActions,
}: Omit<ConfirmDialogProps, 'open'>) {
  const t = useT();
  // 标题 id 每个实例唯一(此前写死 confirm-dialog-title,同时挂载多个时 aria-labelledby 指向错乱)。
  const titleId = useId();
  // a11y:说明区经 aria-describedby 关联(WAI-ARIA APG Dialog / Alert Dialog)。初始焦点常在「取消」,不关联时读屏只读
  // 标题 + 焦点按钮,听不到文件名 / 进程名 / 删除列表 / 未保存警告等正文。
  const descriptionId = useId();
  const confirmText = confirmLabel ?? t('panels.explorer.confirm.confirm');
  const cancelText = cancelLabel ?? t('panels.explorer.confirm.cancel');
  // 引用必须稳定(同 PermissionPrompt handleClose):调用方都传内联 onCancel,Modal 的焦点 /
  // 键盘 effect 依赖 onClose,父组件每次重渲换新引用会让它 cleanup 再重跑 → 焦点被拉回
  // [data-autofocus] 确认(危险)按钮、键盘栈重排。Esc / overlay 仍调最新的。
  const handleClose = useStableCallback(onCancel);
  return (
    <Modal
      visible
      onClose={handleClose}
      // destructive(可能丢数据、须立即决定)用 alertdialog;Modal 的 role 可由调用方覆盖。
      role={destructive ? 'alertdialog' : 'dialog'}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <h2
        id={titleId}
        className="mb-2 text-sm font-medium text-fg"
      >
        {title}
      </h2>
      <div id={descriptionId} className="mb-5 text-xs leading-relaxed text-fg-muted">
        {description}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {extraActions?.map((a) => (
          <Button key={a.label} variant="ghost" size="sm" onClick={a.onClick}>
            {a.label}
          </Button>
        ))}
        {alternativeLabel !== undefined && onAlternative !== undefined && (
          <Button variant="ghost" size="sm" onClick={onAlternative}>
            {alternativeLabel}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          // 数据完整性:destructive 确认框常在用户操作后异步弹出(Cmd+S 遇外部修改 →「仍然覆盖」),
          // 用户继续打的空格 / 回车会激活焦点按钮 —— 初始焦点放在取消,破坏性操作须显式选择(defaultAction 缺省)。
          data-autofocus={defaultAction === 'cancel' ? true : undefined}
        >
          {cancelText}
        </Button>
        <Button
          variant={destructive ? 'danger' : 'primary'}
          size="sm"
          onClick={onConfirm}
          // a11y(A20):非破坏性确认按钮排在取消之后,但应是初始焦点。用 data-autofocus(Modal
          // 优先聚焦它),取代 React autoFocus —— 后者会被 Modal rAF 覆盖到第一个(取消)按钮。
          // 可恢复的破坏性操作(移到废纸篓)经 defaultAction='confirm' 也落在这里。
          data-autofocus={defaultAction === 'confirm' ? true : undefined}
        >
          {confirmText}
        </Button>
      </div>
    </Modal>
  );
}
