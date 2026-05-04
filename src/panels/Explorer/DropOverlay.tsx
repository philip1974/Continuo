interface DropOverlayProps {
  /** 当前会落入的目录 path. */
  targetDir: string;
}

// 拖拽时覆盖整面板的提示层。pointer-events-none 确保不挡住下层 dragover 事件。
export function DropOverlay({ targetDir }: DropOverlayProps) {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center border-2 border-dashed border-sky-400 bg-sky-500/15">
      <div className="rounded bg-neutral-900/90 px-4 py-2 text-xs text-neutral-100 shadow-lg">
        放下以上传到 <code className="text-sky-300">{targetDir}</code>
      </div>
    </div>
  );
}
