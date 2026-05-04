// 无 tab 时的占位。鼓励用户去 Explorer 单击文件打开。
export function EditorWelcome() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-6 text-center text-sm text-neutral-400">
      <div className="text-xs uppercase tracking-wider text-neutral-500">
        未打开文件
      </div>
      <div className="max-w-sm leading-relaxed">
        在 <span className="text-neutral-300">Explorer</span> 面板单击任意文件即可打开;
        右键文件夹可"新建文件"。
      </div>
      <div className="text-[11px] text-neutral-600">
        Markdown 文件自动保存(2 秒防抖) · 代码文件需 ⌘S 显式保存
      </div>
    </div>
  );
}
