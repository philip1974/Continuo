// 无 tab 时的占位。极简两行 + 一行 hint。
export function EditorWelcome() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-fg-muted">
      <div className="text-xs uppercase tracking-wider text-fg-dim">
        未打开文件
      </div>
      <div className="text-[11px] text-fg-dim">
        在 Explorer 单击文件打开 · ⌘S 保存
      </div>
    </div>
  );
}
