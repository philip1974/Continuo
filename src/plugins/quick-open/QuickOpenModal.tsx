// Quick Open Modal(VSCode ⌘P 同款)— UI 仿 CommandPalette.
//
// 数据流:
//   open() → useEffect 监 isOpen+root 变化 → walkWorkspaceFiles →
//   setLoading(true) → 拿到 files → setResults(files) + setLoading(false)
//   query 变 → fuzzyFilter(results) → 渲染列表
//   Enter → openFileByPath(absPath) + close()

import { useCallback, useEffect, useMemo } from 'react';
import { Input, Modal, Spinner } from '@/design';
import { useQuickOpenStore, type QuickOpenFile } from './store';
import { walkWorkspaceFiles } from './walk-files';
import { fuzzyFilter } from '../command-palette/fuzzy';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { coApi } from '@/lib/co-api';
import { openFileByPath } from '@/panels/Editor/editor-file-actions';
import { useEditorStore } from '@/stores/editor.store';

export function QuickOpenModal() {
  const isOpen = useQuickOpenStore((s) => s.isOpen);
  const query = useQuickOpenStore((s) => s.query);
  const selectedIndex = useQuickOpenStore((s) => s.selectedIndex);
  const results = useQuickOpenStore((s) => s.results);
  const loading = useQuickOpenStore((s) => s.loading);
  const close = useQuickOpenStore((s) => s.close);
  const setQuery = useQuickOpenStore((s) => s.setQuery);
  const moveSelection = useQuickOpenStore((s) => s.moveSelection);
  const setResults = useQuickOpenStore((s) => s.setResults);
  const setLoading = useQuickOpenStore((s) => s.setLoading);

  const root = useWorkspaceStore((s) => s.root);

  // 打开 modal 时(或 root 变化)异步 walk 文件。已有 results 不阻塞 UI,
  // 后台刷新 → setResults。
  useEffect(() => {
    if (!isOpen || !root) return;
    let cancelled = false;
    setLoading(true);
    void walkWorkspaceFiles({
      rootPath: root,
      listDir: (p, opts) => coApi.fs.listDir(p, opts),
    })
      .then((r) => {
        if (cancelled) return;
        if (r.ok) {
          setResults(r.data);
        } else {
          console.warn('[quick-open] walk failed', r.code, r.message);
          setResults([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, root, setResults, setLoading]);

  // fuzzy 用 relPath 做匹配源(让用户能输 'src/foo' 这种路径片段);
  // 命名优先级保留在 fuzzyScore 词边界加分里(/ 算 boundary)。
  const filtered = useMemo(
    () => fuzzyFilter(results, query, (f) => f.relPath),
    [results, query],
  );

  const openFile = useCallback(
    async (file: QuickOpenFile) => {
      close();
      try {
        const r = await openFileByPath(file.absPath, {
          fs: { readFile: coApi.fs.readFile, writeFile: coApi.fs.writeFile },
          store: useEditorStore,
        });
        if (!r.ok) {
          console.warn(`[quick-open] open ${file.absPath} failed:`, r.code, r.message);
        }
      } catch (err) {
        console.warn('[quick-open] openFileByPath threw', err);
      }
    },
    [close],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1, filtered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1, filtered.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const file = filtered[selectedIndex];
      if (file) void openFile(file);
    }
  };

  return (
    <Modal visible={isOpen} onClose={close} size="lg" className="!p-0 !rounded-md">
      <div className="flex flex-col">
        <div className="border-b border-line p-2">
          <Input
            size="sm"
            autoFocus
            placeholder="搜索文件名 / 路径片段(⌘⇧P 切到命令面板)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="max-h-[420px] overflow-y-auto py-1">
          {!root ? (
            <div className="px-3 py-4 text-center text-xs text-fg-dim">
              请先在 Explorer 打开工作区
            </div>
          ) : loading && results.length === 0 ? (
            <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-fg-dim">
              <Spinner size="sm" />
              <span>扫描中…</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-fg-dim">
              {results.length === 0 ? '工作区无文件' : '无匹配文件'}
            </div>
          ) : (
            <ul>
              {filtered.map((f, idx) => (
                <li
                  key={f.absPath}
                  className={[
                    'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs',
                    // 键盘 selectedIndex 走 active bg(深色),独立于鼠标 hover
                    idx === selectedIndex
                      ? 'bg-hover text-fg'
                      : 'text-fg-muted hover:bg-hover/50',
                  ].join(' ')}
                  onClick={() => void openFile(f)}
                >
                  <span className="truncate font-medium">{f.name}</span>
                  <span className="ml-auto truncate text-2xs text-fg-dim">
                    {f.relPath}
                  </span>
                </li>
              ))}
              {results.length >= 5000 && filtered.length > 0 && (
                <li className="px-3 py-1 text-center text-2xs text-fg-dim">
                  仅显示前 5000 个文件;输入更具体的查询缩小范围
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
