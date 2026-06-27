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
import {
  formatHotkey,
  detectPlatform,
} from '../command-palette/format-hotkey';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { coApi } from '@/lib/co-api';
import { useT } from '@/i18n';
import { localizeErrorByCode } from '@/lib/localize-error';
import { openFileByPath } from '@/panels/Editor/editor-file-actions';
import { useEditorStore } from '@/stores/editor.store';

// race(R2):稳定空数组引用,跨 root 时 liveResults 返回它,避免每次渲染新建 [] 触发 useMemo。
const EMPTY_RESULTS: readonly QuickOpenFile[] = [];
const QUICK_OPEN_ROW_BASE_CLASS_NAME =
  'flex cursor-pointer items-center gap-2 px-3 text-xs';
const QUICK_OPEN_ROW_SELECTED_CLASS_NAME =
  `${QUICK_OPEN_ROW_BASE_CLASS_NAME} bg-hover text-fg`;
const QUICK_OPEN_ROW_IDLE_CLASS_NAME =
  `${QUICK_OPEN_ROW_BASE_CLASS_NAME} text-fg-muted hover:bg-hover/50`;

export function quickOpenRowClassName(selected: boolean): string {
  return selected ? QUICK_OPEN_ROW_SELECTED_CLASS_NAME : QUICK_OPEN_ROW_IDLE_CLASS_NAME;
}

export function isVirtualIndexRendered(
  virtualItems: readonly { readonly index: number }[],
  selectedIndex: number,
): boolean {
  for (const item of virtualItems) {
    if (item.index === selectedIndex) return true;
  }
  return false;
}

/**
 * 轻量 shell(打磨 R33,仿 R32 CommandPalette):QuickOpenModal 常驻挂在 App 顶层。
 * 外层只订阅 isOpen/close 渲染 Modal,**仅 isOpen 时才挂载 QuickOpenBody** —— 关闭
 * 状态下不再订阅 query/results/root/loading、不跑 fuzzyFilter、不创建 virtualizer。
 * results 仍留在 store,支持秒级再开复用。
 */
export function QuickOpenModal() {
  const isOpen = useQuickOpenStore((s) => s.isOpen);
  const close = useQuickOpenStore((s) => s.close);
  const t = useT(); // a11y(A13):给无标题 dialog 命名
  return (
    <Modal
      visible={isOpen}
      onClose={close}
      size="lg"
      className="!p-0 !rounded-md"
      // a11y(A13):无可见标题的 dialog → aria-label 命名(复用 input_aria「搜索文件」)。
      aria-label={t('quick_open.input_aria')}
    >
      {isOpen && <QuickOpenBody />}
    </Modal>
  );
}

function QuickOpenBody() {
  const t = useT();
  const query = useQuickOpenStore((s) => s.query);
  const selectedIndex = useQuickOpenStore((s) => s.selectedIndex);
  const results = useQuickOpenStore((s) => s.results);
  const resultsRoot = useQuickOpenStore((s) => s.resultsRoot);
  const loading = useQuickOpenStore((s) => s.loading);
  const close = useQuickOpenStore((s) => s.close);
  const setQuery = useQuickOpenStore((s) => s.setQuery);
  const moveSelection = useQuickOpenStore((s) => s.moveSelection);
  const clampSelection = useQuickOpenStore((s) => s.clampSelection);
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
    // race(R2):若 store 里的 results 属于另一个 root(切 workspace 后重开),立即清空并标记
    // 当前 root,否则扫描期间渲染会展示/允许打开旧 workspace 文件(跨 root 泄漏)。同 root 保留
    // 复用优化(不清,后台刷新)。
    if (useQuickOpenStore.getState().resultsRoot !== root) {
      setResults([], root);
    }
    setLoading(true);
    setScanFailed(false);
    void walkWorkspaceFiles({
      rootPath: root,
      listDir: (p, opts) => coApi.fs.listDir(p, opts),
    })
      .then((r) => {
        if (cancelled) return;
        if (r.ok) {
          setResults(r.data, root);
        } else {
          // walk 失败:置 scanFailed 标志,UI 显式区分"扫描失败 + 重试"与"空 workspace",
          // 不再让失败静默伪装成空列表把用户引向死胡同。见第二十一轮 P1-AY。
          console.warn('[quick-open] walk failed', r.code, r.message);
          setResults([], root);
          setScanFailed(true);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[quick-open] walk threw', err);
        setResults([], root);
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
  // race(R2):只信任归属当前 root 的 results;effect 异步清理前的一帧也不展示旧 root 结果。
  const liveResults = useMemo(
    () => (resultsRoot === root ? results : EMPTY_RESULTS),
    [resultsRoot, root, results],
  );
  const filtered = useMemo(
    () =>
      fuzzyFilter(
        liveResults,
        query,
        (f) => f.relPath,
        (f) => f.relPathLower,
      ),
    [liveResults, query],
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

  // race(R48):filtered 变短(后台 scan setResults 替换列表 / query 收窄)时把 selectedIndex 钳回
  // [0,len-1],防 Enter 读 filtered[selectedIndex]=undefined 打开失效 + 高亮/滚动停越界项。须在
  // 下方 scroll effect 之前生效(声明在前 → 同次提交里先钳后滚)。
  useEffect(() => {
    clampSelection(filtered.length);
  }, [filtered.length, clampSelection]);

  // 键盘改 selectedIndex → 滚到可视区(虚拟化后选中行可能未挂载)。
  useEffect(() => {
    if (filtered.length === 0) return;
    rowVirtualizer.scrollToIndex(selectedIndex);
  }, [selectedIndex, filtered.length, rowVirtualizer]);
  // a11y(A112,A111 后续):aria-activedescendant 只能指向 DOM 中真实挂载的 option;虚拟列表里
  // 选中项可能不在渲染窗口内 → 须校验其在 getVirtualItems() 内,否则引用悬空。
  const activeOptionRendered = isVirtualIndexRendered(
    rowVirtualizer.getVirtualItems(),
    selectedIndex,
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
          // 见第二十一轮 P1-AX。i18n(I8,I6/I7 同族):openFileByPath 返回 FS_NOT_FOUND/
          // FS_DENIED/FS_IO(有三语言 catalog),按 code 经 localizeErrorByCode 本地化,
          // zh/ko 不再看到 main raw 英文;无对应 catalog key 的 code 回退原 message。
          notify.error(
            `${t('quick_open.open_failed')} ${file.name}: ${localizeErrorByCode(r.code, r.message ?? r.code)}`,
          );
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
          // a11y(A2,A1 同族):placeholder 含快捷键参数不适合作可访问名;用专用简洁
          // aria-label,给屏幕阅读器稳定的「搜索文件」名称。
          aria-label={t('quick_open.input_aria')}
          // a11y(A15,CommandPalette 同模式):combobox —— 焦点留输入框、上下键移动 listbox
          // 虚拟选中,须 role=combobox + aria-controls + aria-activedescendant 指向当前 option。
          role="combobox"
          // a11y(A100,CommandPalette 同模式):打开即弹层可见 → aria-expanded 恒 true;
          // 按结果数设 false 会与可见空态矛盾。无结果只移除 aria-activedescendant(下方)。
          aria-expanded
          // a11y(A101,A100 后续):listbox 只在有结果时渲染 → 仅有结果时设 aria-controls,避免悬空。
          aria-controls={filtered.length > 0 ? 'quick-open-listbox' : undefined}
          // a11y(A111,A101 同族):结果异步变短时 selectedIndex 可能越界 → 须校验下标有效,
          // 否则 aria-activedescendant 指向不存在的 option id,SR 失去当前项语义。
          aria-activedescendant={
            selectedIndex >= 0 &&
            selectedIndex < filtered.length &&
            activeOptionRendered
              ? `quick-open-option-${selectedIndex}`
              : undefined
          }
          placeholder={t('quick_open.placeholder', {
            shortcut: formatHotkey('mod+shift+p', detectPlatform()),
          })}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div ref={scrollRef} className="max-h-[420px] overflow-y-auto py-1">
        {!root ? (
          // a11y(A69,A56 同族):弹窗打开焦点自动落搜索框,无 workspace 空态须 role=status,
          // 否则 SR 用户不被告知"当前无法搜索文件"及原因。
          <div role="status" className="px-3 py-4 text-center text-xs text-fg-dim">
            {t('quick_open.no_workspace')}
          </div>
        ) : loading && liveResults.length === 0 ? (
          // a11y(A102,A93 同族):扫描中态须 role=status 播报「正在扫描」具体语义,Spinner 自带
          // 泛化 role=status+aria-label="Loading" → 给 Spinner aria-hidden 抑制,避免双 status
          // 且只听到泛化 loading。
          <div
            role="status"
            className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-fg-dim"
          >
            <Spinner size="sm" aria-hidden />
            <span>{t('quick_open.scanning')}</span>
          </div>
        ) : scanFailed && liveResults.length === 0 ? (
          // 扫描失败:与"空 workspace"区分 + 给重试入口,不让失败静默伪装成空。
          // a11y(A45,A41 同族):异步插入的扫描失败提示须 role=alert,焦点在搜索框时也能播报。
          <div
            role="alert"
            className="flex flex-col items-center gap-2 px-3 py-6 text-center text-xs text-fg-dim"
          >
            <span>{t('quick_open.scan_failed')}</span>
            <Button size="sm" variant="ghost" onClick={() => setReloadToken((n) => n + 1)}>
              {t('quick_open.retry')}
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          // a11y(A56,CommandPalette 兄弟):焦点锁搜索框,输入致结果空时须 live region 播报无匹配。
          <div role="status" className="px-3 py-4 text-center text-xs text-fg-dim">
            {liveResults.length === 0 ? t('quick_open.empty') : t('quick_open.no_match')}
          </div>
        ) : (
          <>
            <ul
              id="quick-open-listbox"
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
                    id={`quick-open-option-${idx}`}
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
                    // 键盘 selectedIndex 走 active bg(深色),独立于鼠标 hover
                    className={quickOpenRowClassName(idx === selectedIndex)}
                    onClick={() => void openFile(f)}
                  >
                    <span className="truncate font-medium">{f.name}</span>
                    <span className="ml-auto truncate text-2xs text-fg-dim">{f.relPath}</span>
                  </li>
                );
              })}
            </ul>
            {liveResults.length >= 5000 && filtered.length > 0 && (
              // a11y(A65,A56 同族):扫描到 5000 文件截断的提示是动态出现的信息,焦点锁在搜索框
              // 时 SR 用户不会获知结果被截断、搜索范围不完整 → role=status(polite 中性提示)。
              <div role="status" className="px-3 py-1 text-center text-2xs text-fg-dim">
                {t('quick_open.limit_hint')}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
