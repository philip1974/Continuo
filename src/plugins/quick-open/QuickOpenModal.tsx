// Quick Open Modal(VSCode ⌘P 同款)— UI 仿 CommandPalette.
//
// 数据流:
//   open() → useEffect 监 isOpen+root 变化 → walkWorkspaceFiles →
//   setLoading(true) → 拿到 files → setResults(files) + setLoading(false)
//   query 变 → fuzzyFilter(results) → 渲染列表
//   Enter → openFileByPath(absPath) + close()

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
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

/**
 * 轻量 shell(打磨 R33,仿 R32 CommandPalette):QuickOpenModal 常驻挂在 App 顶层。
 * 外层只订阅 isOpen/close 渲染 Modal,**仅 isOpen 时才挂载 QuickOpenBody** —— 关闭
 * 状态下不再订阅 query/results/root/loading、不跑 fuzzyFilter、不创建 virtualizer。
 * results 仍留在 store,支持秒级再开复用。
 */
export function QuickOpenModal() {
  const isOpen = useQuickOpenStore((s) => s.isOpen);
  const close = useQuickOpenStore((s) => s.close);
  return (
    <Modal visible={isOpen} onClose={close} size="lg" className="!p-0 !rounded-md">
      {isOpen && <QuickOpenBody />}
    </Modal>
  );
}

function QuickOpenBody() {
  const t = useT();
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
    // body 仅在 isOpen 时挂载(打磨 R33),故无需再判 isOpen,挂载即等于打开。
    if (!root) return;
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
  }, [root, reloadToken, setResults, setLoading, setScanFailed]);

  // fuzzy 用 relPath 做匹配源(让用户能输 'src/foo' 这种路径片段);
  // 命名优先级保留在 fuzzyScore 词边界加分里(/ 算 boundary)。
  // 性能 P16:传预计算的 relPathLower(scan 时一次),避免每按键对 ≤5000 候选重 lowercasing。
  const filtered = useMemo(
    () =>
      fuzzyFilter(
        results,
        query,
        (f) => f.relPath,
        (f) => f.relPathLower,
      ),
    [results, query],
  );

  // 虚拟化列表(打磨 R25):filtered 仍是逻辑全集(最多 5000),但只渲染可视行,
  // DOM 节点从最多 5000 降到几十。复用项目已有 @tanstack/react-virtual(同
  // FolderTree)。selectedIndex / Enter 语义不变,键盘移动时 scrollToIndex 跟随。
  const ROW_H = 28; // li: py-1.5 text-xs ≈ 28px
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  // 键盘改 selectedIndex → 滚到可视区(虚拟化后选中行可能未挂载)。
  useEffect(() => {
    if (filtered.length === 0) return;
    rowVirtualizer.scrollToIndex(selectedIndex);
  }, [selectedIndex, filtered.length, rowVirtualizer]);

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
      <div ref={scrollRef} className="max-h-[420px] overflow-y-auto py-1">
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
            <Button size="sm" variant="ghost" onClick={() => setReloadToken((n) => n + 1)}>
              {t('quick_open.retry')}
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-fg-dim">
            {results.length === 0 ? t('quick_open.empty') : t('quick_open.no_match')}
          </div>
        ) : (
          <>
            <ul
              role="listbox"
              aria-label={t('quick_open.list_aria')}
              style={{
                height: rowVirtualizer.getTotalSize(),
                position: 'relative',
              }}
            >
              {rowVirtualizer.getVirtualItems().map((vRow) => {
                const idx = vRow.index;
                const f = filtered[idx]!;
                return (
                  <li
                    key={f.absPath}
                    role="option"
                    aria-selected={idx === selectedIndex}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: vRow.size,
                      transform: `translateY(${vRow.start}px)`,
                    }}
                    className={[
                      'flex cursor-pointer items-center gap-2 px-3 text-xs',
                      // 键盘 selectedIndex 走 active bg(深色),独立于鼠标 hover
                      idx === selectedIndex
                        ? 'bg-hover text-fg'
                        : 'text-fg-muted hover:bg-hover/50',
                    ].join(' ')}
                    onClick={() => void openFile(f)}
                  >
                    <span className="truncate font-medium">{f.name}</span>
                    <span className="ml-auto truncate text-2xs text-fg-dim">{f.relPath}</span>
                  </li>
                );
              })}
            </ul>
            {results.length >= 5000 && filtered.length > 0 && (
              <div className="px-3 py-1 text-center text-2xs text-fg-dim">
                {t('quick_open.limit_hint')}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
