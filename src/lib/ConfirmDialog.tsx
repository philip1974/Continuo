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
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * 可选第三按钮(如关闭脏文件的「保存 / 不保存 / 取消」里的「不保存」),排在取消左侧、ghost 样式;
   * alternativeLabel 与 onAlternative 都给才渲染。不参与初始焦点(仍按 destructive 规则落在确认或取消)。
   */
  alternativeLabel?: string;
  onAlternative?: () => void;
}

// 通用确认对话框(design Modal):编辑器关闭 / 覆盖确认、插件卸载、状态栏撤销授权共用(原在 panels/Explorer 下,
// Explorer 删除已改为直接进回收站不再确认,故移到 lib)。
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
  onConfirm,
  onCancel,
  alternativeLabel,
  onAlternative,
}: Omit<ConfirmDialogProps, 'open'>) {
  const t = useT();
  // 标题 id 每个实例唯一(此前写死 confirm-dialog-title,同时挂载多个时 aria-labelledby 指向错乱)。
  const titleId = useId();
  const confirmText = confirmLabel ?? t('panels.explorer.confirm.confirm');
  const cancelText = cancelLabel ?? t('panels.explorer.confirm.cancel');
  // 引用必须稳定(同 PermissionPrompt handleClose):调用方都传内联 onCancel,Modal 的焦点 /
  // 键盘 effect 依赖 onClose,父组件每次重渲换新引用会让它 cleanup 再重跑 → 焦点被拉回
  // [data-autofocus] 确认(危险)按钮、键盘栈重排。Esc / overlay 仍调最新的。
  const handleClose = useStableCallback(onCancel);
  return (
    <Modal visible onClose={handleClose} aria-labelledby={titleId}>
      <h2
        id={titleId}
        className="mb-2 text-sm font-medium text-fg"
      >
        {title}
      </h2>
      <div className="mb-5 text-xs leading-relaxed text-fg-muted">
        {description}
      </div>
      <div className="flex justify-end gap-2">
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
          // 用户继续打的空格 / 回车会激活焦点按钮 —— 初始焦点放在取消,破坏性操作须显式选择。
          data-autofocus={destructive ? true : undefined}
        >
          {cancelText}
        </Button>
        <Button
          variant={destructive ? 'danger' : 'primary'}
          size="sm"
          onClick={onConfirm}
          // a11y(A20):非破坏性确认按钮排在取消之后,但应是初始焦点。用 data-autofocus(Modal
          // 优先聚焦它),取代 React autoFocus —— 后者会被 Modal rAF 覆盖到第一个(取消)按钮。
          data-autofocus={destructive ? undefined : true}
        >
          {confirmText}
        </Button>
      </div>
    </Modal>
  );
}
