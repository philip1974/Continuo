// 无 tab 时的占位(UI polish)。
// 对齐 demo(industrial dark):大圆形 document icon + 标题 + KeyCap 副提示。

import { KeyCap } from '@/design';

export function EditorWelcome() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-6 text-center">
      <div
        aria-hidden="true"
        className="flex h-28 w-28 items-center justify-center rounded-full border border-line bg-panel-soft/40"
      >
        <svg
          viewBox="0 0 24 24"
          width="48"
          height="48"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-fg-dim"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M9 13h6" />
          <path d="M9 17h6" />
        </svg>
      </div>
      <div className="text-base font-medium text-fg">未打开文件</div>
      <div className="flex items-center gap-1.5 text-xs text-fg-muted">
        <span>在 Explorer 单击文件打开 ·</span>
        <KeyCap>⌘</KeyCap>
        <KeyCap>S</KeyCap>
        <span>保存</span>
      </div>
    </div>
  );
}
