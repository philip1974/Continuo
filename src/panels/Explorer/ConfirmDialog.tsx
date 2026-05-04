import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '@/design';

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

// 通用确认对话框(Radix)。删除走这条;以后扩展(覆盖确认等)同模式。
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
    <Dialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 w-[420px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-neutral-800 bg-neutral-950 p-5 shadow-xl outline-none"
          onEscapeKeyDown={onCancel}
        >
          <Dialog.Title className="mb-2 text-sm font-medium text-neutral-100">
            {title}
          </Dialog.Title>
          <Dialog.Description asChild>
            <div className="mb-5 text-xs leading-relaxed text-neutral-400">
              {description}
            </div>
          </Dialog.Description>
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
