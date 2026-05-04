import { useEditorStore, type EditorMode, type EditorTab } from '@/stores/editor.store';

interface EditorToolbarProps {
  activeTab: EditorTab | null;
  onSave: () => void;
  /** 是否启用自动保存(Markdown 启用,代码不启用). */
  autoSaveEnabled: boolean;
}

const MODE_LABEL: Record<EditorMode, string> = {
  edit: 'Edit',
  source: 'Source',
  preview: 'Preview',
};

function basename(p: string | null): string {
  if (!p) return '未保存草稿';
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

// 顶部 32px 工具栏:
//   左:文件名 + dirty 状态
//   中:mode 切换(仅 markdown 文件可见,代码文件不显示)
//   右:保存按钮 + 自动保存 hint
export function EditorToolbar({ activeTab, onSave, autoSaveEnabled }: EditorToolbarProps) {
  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);

  const isMarkdown = autoSaveEnabled; // 等价:.md/.markdown 才允许 mode 切换
  const dirty = activeTab?.dirty ?? false;

  return (
    <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-b border-neutral-800 bg-neutral-900/60 px-3 text-xs">
      <div className="flex min-w-0 items-center gap-2 text-neutral-300">
        <span className="truncate font-medium" title={activeTab?.filePath ?? ''}>
          {basename(activeTab?.filePath ?? null)}
        </span>
        {dirty && (
          <span className="text-[10px] text-sky-400">●</span>
        )}
      </div>

      {isMarkdown && (
        <div className="flex items-center gap-0.5 rounded bg-neutral-800/60 p-0.5">
          {(['edit', 'source', 'preview'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={[
                'rounded px-2 py-0.5 text-[11px] transition',
                mode === m
                  ? 'bg-neutral-700 text-neutral-100'
                  : 'text-neutral-400 hover:text-neutral-200',
              ].join(' ')}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 text-[10px] text-neutral-500">
        {autoSaveEnabled && (
          <span title="Markdown 文件 2 秒防抖自动保存">
            {dirty ? '保存中…' : '已自动保存'}
          </span>
        )}
        <button
          type="button"
          onClick={onSave}
          disabled={!activeTab || !dirty}
          className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 transition hover:bg-neutral-800 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
          title="保存(⌘S)"
        >
          保存
        </button>
      </div>
    </div>
  );
}
