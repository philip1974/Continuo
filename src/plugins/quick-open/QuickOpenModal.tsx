// Quick Open Modal(VSCode ⌘P 同款)— UI 仿 CommandPalette.
//
// 数据流:
//   open() → useEffect 监 isOpen+root 变化 → walkWorkspaceFiles →
//   setLoading(true) → 拿到 files → setResults(files) + setLoading(false)
//   query 变 → fuzzyFilter(results) → 渲染列表
//   Enter → openFileByPath(absPath) + close()

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Modal, Spinner } from '@/design';
import { notify } from '@/notifications/notify';
import { useQuickOpenStore, type QuickOpenFile } from './store';
import { walkWorkspaceFiles } from './walk-files';
import { fuzzyFilter } from '../command-palette/fuzzy';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { coApi } from '@/lib/co-api';
import { useT } from '@/i18n';
import { openFileByPath } from '@/panels/Editor/editor-file-actions';
import { useEditorStore } from '@/stores/editor.store';

export function QuickOpenModal() {
  const t = useT();
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
  const scanFailed = useQuickOpenStore((s) => s.scanFailed);
  const setScanFailed = useQuickOpenStore((s) => s.setScanFailed);

  const root = useWorkspaceStore((s) => s.root);
  // 重试令牌:walk 失败后用户点"重试"递增 → 重跑 effect。
  const [reloadToken, setReloadToken] = useState(0);

  // 打开 modal 时(或 root 变化)异步 walk 文件。已有 results 不阻塞 UI,
  // 后台刷新 → setResults。
  useEffect(() => {
    if (!isOpen || !root) return;
    let cancelled = false;
    setLoading(true);
    setScanFailed(false);
    void walkWorkspaceFiles({
      rootPath: root,
      listDir: (p, opts) => coApi.fs.listDir(p, opts),
    })
      .then((r) => {
        if (cancelled) return;
        if (r.ok) {
          setResults(r.data);
        } else {
          // walk 失败:置 scanFailed 标志,UI 显式区分"扫描失败 + 重试"与"空 workspace",
          // 不再让失败静默伪装成空列表把用户引向死胡同。见第二十一轮 P1-AY。
          console.warn('[quick-open] walk failed', r.code, r.message);
          setResults([]);
          setScanFailed(true);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[quick-open] walk threw', err);
        setResults([]);
        setScanFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, root, reloadToken, setResults, setLoading, setScanFailed]);

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
          // 打开失败弹 error toast(modal 已关,旧实现只 console.warn → 用户点了没反应)。
          // 见第二十一轮 P1-AX。
          notify.error(`${t('quick_open.open_failed')} ${file.name}: ${r.message ?? r.code}`);
        }
      } catch (err) {
        notify.error(
          `${t('quick_open.open_failed')} ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [close, t],
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
            placeholder={t('quick_open.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="max-h-[420px] overflow-y-auto py-1">
          {!root ? (
            <div className="px-3 py-4 text-center text-xs text-fg-dim">
              {t('quick_open.no_workspace')}
            </div>
          ) : loading && results.length === 0 ? (
            <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-fg-dim">
              <Spinner size="sm" />
              <span>{t('quick_open.scanning')}</span>
            </div>
          ) : scanFailed && results.length === 0 ? (
            // 扫描失败:与"空 workspace"区分 + 给重试入口,不让失败静默伪装成空。
            <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-xs text-fg-dim">
              <span>{t('quick_open.scan_failed')}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setReloadToken((n) => n + 1)}
              >
                {t('quick_open.retry')}
              </Button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-fg-dim">
              {results.length === 0
                ? t('quick_open.empty')
                : t('quick_open.no_match')}
            </div>
          ) : (
            <ul role="listbox" aria-label={t('quick_open.list_aria')}>
              {filtered.map((f, idx) => (
                <li
                  key={f.absPath}
                  role="option"
                  aria-selected={idx === selectedIndex}
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
                  {t('quick_open.limit_hint')}
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
