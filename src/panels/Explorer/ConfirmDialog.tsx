import { Button, Modal } from '@/design';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

// 通用确认对话框(design Modal)。删除走这条;以后扩展(覆盖确认等)同模式。
// design Modal 自带 ESC + overlay 点击 → onClose,这里把 onClose 接到 onCancel。
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal visible={open} onClose={onCancel} aria-labelledby="confirm-dialog-title">
      <h2
        id="confirm-dialog-title"
        className="mb-2 text-sm font-medium text-fg"
      >
        {title}
      </h2>
      <div className="mb-5 text-xs leading-relaxed text-fg-muted">
        {description}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          variant={destructive ? 'danger' : 'primary'}
          size="sm"
          onClick={onConfirm}
          autoFocus
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
