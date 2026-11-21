// 无 tab 时的占位(UI polish)。
// 对齐 demo(industrial dark):大圆形 document icon + 标题 + KeyCap 副提示。

import { useMemo } from 'react';
import { KeyCap } from '@/design';
import { useT } from '@/i18n';
import {
  formatHotkeyParts,
  detectPlatform,
} from '@/plugins/command-palette/format-hotkey';

const DOCUMENT_ICON = (
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
);

export function EditorWelcome() {
  const t = useT();
  const saveHotkeyParts = useMemo(
    () => formatHotkeyParts('mod+s', detectPlatform()),
    [],
  );
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-6 text-center">
      <div
        aria-hidden="true"
        className="flex h-28 w-28 items-center justify-center rounded-full border border-line bg-panel-soft/40"
      >
        {DOCUMENT_ICON}
      </div>
      <div className="text-base font-medium text-fg">{t('editor.welcome.title')}</div>
      <div className="flex items-center gap-1.5 text-xs text-fg-muted">
        <span>{t('editor.welcome.hint_prefix')}</span>
        {saveHotkeyParts.map((p, i) => (
          <KeyCap key={i}>{p}</KeyCap>
        ))}
        <span>{t('editor.welcome.save')}</span>
      </div>
    </div>
  );
}
