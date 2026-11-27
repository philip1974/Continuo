// 保存冲突差异 tab(VSCode「{file} (in file) ↔ {file} (in Code)」差异编辑器;懒加载 chunk,含 @codemirror/merge)。
//
// - 左:磁盘当前内容,只读(可聚焦、可选中复制);磁盘再次变化(dir-changed 命中该文件 / watcher 恢复)→ 重读并更新。
// - 右:你的版本 = 编辑器 store 里的同一文档:这里输入即改原 tab(原 tab 同步变脏 / 变化),原 tab 里的编辑也同步过来。
// - 逐行高亮 + 行内差异(@codemirror/merge highlightChanges);上一处 / 下一处差异(工具栏按钮,编辑器内 Alt+F5 / Shift+Alt+F5,
//   同 VSCode workbench.action.compareEditor.nextChange / previousChange),导航后读屏播报「第 n 处差异(共 m 处),第 L 行」。
// - 接受我的版本 / 使用磁盘版本(见 conflict-compare resolveConflict)。
// - 两侧合计过大(CONFLICT_DIFF_MAX_CHARS)不计算差异,只显示提示;差异计算另有单次超时。
// Markdown 按源码文本比较(markdown 高亮)。BDD: src/__tests__/editor-save-conflict-compare/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MergeView, getChunks, goToNextChunk, goToPreviousChunk } from '@codemirror/merge';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view';
import { Button, IconButton } from '@/design';
import { useLocale, useT } from '@/i18n/react';
import { t, translateCount } from '@/i18n';
import { coApi } from '@/lib/co-api';
import { announce } from '@/lib/announce';
import { basename, isSameOrInsidePath } from '@/lib/path-cross';
import { onWatchRestored } from '@/lib/fs-watch-restored';
import { localizeErrorByCode } from '@/lib/localize-error';
import { useTheme } from '@/theme';
import { useSettingValue } from '@/plugins/settings/values-store';
import { EDITOR_FONT_SIZE } from '@/plugins/settings/core-setting-specs';
import { useEditorStore } from '@/stores/editor.store';
import { errorCodeOf, errorMessage } from '../../../electron/shared/error-message';
import { codeEditorBasicSetup } from './codemirror-basic-setup';
import { codeEditorTheme } from './code-editor-theme';
import { codeMirrorContentLabel, codeMirrorPhrases } from './codemirror-phrases';
import { detectLineEnding, languageDescriptionFor, minimalChange, pickLanguage } from './CodeEditor';
import { isMarkdownPath } from './editor-path-utils';
import { findEditorFileTabById } from './editor-tab-lookup';
import { readOptionsForTab } from './editor-encoding';
import type { TextEncodingId } from '../../../electron/shared/text-encoding';
import { rebindCodeMirrorRoots } from './codemirror-root';
import { registerEditorRootRebind } from './editor-root-registry';
import { resolveConflict, type ConflictResolution } from './conflict-compare';
import type { ConflictDiffParams } from './conflict-diff-constants';
import {
  CONFLICT_DIFF_TIMEOUT_MS,
  chunkIndexAt,
  dirChangeTouchesFile,
  isConflictDiffTooLarge,
} from './conflict-diff-model';

type DiskVersion =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'error'; readonly code: string; readonly message?: string };

/**
 * 磁盘版本:挂载时读一次;之后 dir-changed 命中该文件 / watcher 恢复(断线期间可能漏了变化)→ 重读。每次只有一个读在途,
 * 在途期间的事件合并成读完后再读一次(读到最终内容,不乱序回写)。
 */
function useDiskVersion(
  filePath: string | null,
  realPath: string | undefined,
  encoding: TextEncodingId | undefined,
): DiskVersion {
  const [disk, setDisk] = useState<DiskVersion>({ kind: 'loading' });
  const realPathRef = useRef(realPath);
  realPathRef.current = realPath;
  useEffect(() => {
    if (filePath === null) return;
    let cancelled = false;
    let inFlight = false;
    let again = false;
    const read = (): void => {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      // 按 tab 选定的编码读(同外部同步 / 保存前比对;缺省自动识别)
      void (encoding === undefined ? coApi.fs.readFile(filePath) : coApi.fs.readFile(filePath, { encoding }))
        .then(
          (r): DiskVersion => (r.ok ? { kind: 'ok', text: r.data } : { kind: 'error', code: r.code, message: r.message }),
          (err: unknown): DiskVersion => ({ kind: 'error', code: errorCodeOf(err), message: errorMessage(err) }),
        )
        .then((next) => {
          inFlight = false;
          if (cancelled) return;
          if (again) {
            again = false;
            read();
            return;
          }
          setDisk((cur) => (cur.kind === 'ok' && next.kind === 'ok' && cur.text === next.text ? cur : next));
        });
    };
    read();
    const unsubDir = coApi.fs.onDirChanged((dir, files) => {
      if (dirChangeTouchesFile(dir, files, filePath, realPathRef.current)) read();
    });
    const unsubRestored = onWatchRestored((dir) => {
      if (isSameOrInsidePath(dir, filePath)) read();
    });
    return () => {
      cancelled = true;
      unsubDir();
      unsubRestored();
    };
  }, [filePath, encoding]);
  return disk;
}

/** 差异配色:取 git 装饰 token(已在亮 / 暗两套主题里给值),整行淡底 + 行内较深底;gutter 实色条。 */
const diffTheme = EditorView.theme({
  '&.cm-merge-a .cm-changedLine': { backgroundColor: 'color-mix(in srgb, var(--md-git-deleted) 12%, transparent)' },
  '&.cm-merge-b .cm-changedLine': { backgroundColor: 'color-mix(in srgb, var(--md-git-added) 12%, transparent)' },
  '&.cm-merge-a .cm-changedText': { background: 'color-mix(in srgb, var(--md-git-deleted) 34%, transparent)' },
  '&.cm-merge-b .cm-changedText': { background: 'color-mix(in srgb, var(--md-git-added) 34%, transparent)' },
  '&.cm-merge-a .cm-changedLineGutter': { background: 'var(--md-git-deleted)' },
  '&.cm-merge-b .cm-changedLineGutter': { background: 'var(--md-git-added)' },
  // 两侧之间的分隔线
  '&.cm-merge-a': { borderRight: '1px solid var(--md-outline-variant)' },
  '.cm-content': { padding: '8px 0' },
  // 强制颜色(高对比度):底色被抹掉,行内差异改画轮廓仍可辨
  '@media (forced-colors: active)': {
    '.cm-changedText': { outline: '1px solid CanvasText' },
    '.cm-changedLineGutter': { background: 'CanvasText' },
  },
});

interface MergeHostProps {
  readonly tabId: string;
  readonly filePath: string;
  readonly diskText: string;
  /** 导航 / 差异变化后刷新工具栏状态。 */
  readonly onChunksChanged: (count: number, current: number) => void;
  /** 父组件经此拿到导航函数(工具栏按钮用)。 */
  readonly navRef: React.MutableRefObject<((dir: 1 | -1) => void) | null>;
}

function MergeHost({ tabId, filePath, diskText, onChunksChanged, navRef }: MergeHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mvRef = useRef<MergeView | null>(null);
  const { resolved } = useTheme();
  const locale = useLocale();
  const themeCompartment = useRef(new Compartment());
  const phrasesCompartment = useRef(new Compartment());
  const labelA = useRef(new Compartment());
  const labelB = useRef(new Compartment());
  const langA = useRef(new Compartment());
  const langB = useRef(new Compartment());
  const suppressEmit = useRef(false);
  // 右侧文档当前反映的 store 内容(本视图输入的回声不再套回视图)
  const lastSyncedRef = useRef<string | null>(null);
  const eolRef = useRef<'\r\n' | '\n'>('\n');
  const lastFocusedRef = useRef<'a' | 'b'>('b');
  const onChunksRef = useRef(onChunksChanged);
  onChunksRef.current = onChunksChanged;
  const content = useEditorStore((s) => findEditorFileTabById(s.tabs, tabId)?.content ?? null);
  const fontSize = useSettingValue(EDITOR_FONT_SIZE.id, EDITOR_FONT_SIZE.default);

  const report = useCallback((view: EditorView, side: 'a' | 'b') => {
    const chunks = getChunks(view.state)?.chunks ?? [];
    onChunksRef.current(chunks.length, chunkIndexAt(chunks, view.state.selection.main.head, side));
  }, []);

  /** 跳到上一处 / 下一处差异(在最近聚焦的一侧),聚焦该侧并播报位置。 */
  const navigate = useCallback(
    (dir: 1 | -1, from?: EditorView) => {
      const mv = mvRef.current;
      if (!mv) return;
      const side = from ? (from === mv.a ? 'a' : 'b') : lastFocusedRef.current;
      const view = side === 'a' ? mv.a : mv.b;
      (dir > 0 ? goToNextChunk : goToPreviousChunk)(view);
      view.focus();
      const chunks = getChunks(view.state)?.chunks ?? [];
      const head = view.state.selection.main.head;
      const i = chunkIndexAt(chunks, head, side);
      report(view, side);
      if (chunks.length === 0) {
        announce(t('panels.editor.conflict_diff.no_differences'), { doc: view.dom.ownerDocument });
        return;
      }
      if (i < 0) return;
      announce(
        t('panels.editor.conflict_diff.position_line', {
          n: String(i + 1),
          total: String(chunks.length),
          line: String(view.state.doc.lineAt(head).number),
        }),
        { doc: view.dom.ownerDocument },
      );
    },
    [report],
  );
  navRef.current = (dir) => navigate(dir);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const name = basename(filePath);
    const md = isMarkdownPath(filePath);
    const lang = (): Extension => pickLanguage(filePath, md ? 'markdown' : undefined);
    const initial = useEditorStore.getState().tabs.find((x) => x.id === tabId)?.content ?? '';
    eolRef.current = detectLineEnding(initial);
    lastSyncedRef.current = initial;
    const navKeys = Prec.high(
      keymap.of([
        { key: 'Alt-F5', run: (v) => (navigate(1, v), true) },
        { key: 'Shift-Alt-F5', run: (v) => (navigate(-1, v), true) },
      ]),
    );
    const common = (side: 'a' | 'b'): Extension[] => [
      codeEditorBasicSetup,
      navKeys,
      themeCompartment.current.of(codeEditorTheme(resolved)),
      phrasesCompartment.current.of(codeMirrorPhrases()),
      diffTheme,
      EditorView.theme({ '&': { fontSize: 'inherit' }, '.cm-gutters': { border: 'none' } }),
      EditorView.domEventHandlers({
        focus: () => {
          lastFocusedRef.current = side;
        },
      }),
    ];
    const mv = new MergeView({
      a: {
        doc: diskText,
        extensions: [
          ...common('a'),
          EditorState.readOnly.of(true),
          labelA.current.of(codeMirrorContentLabel(t('panels.editor.conflict_diff.disk_label', { name }))),
          langA.current.of(lang()),
          EditorView.updateListener.of((u: ViewUpdate) => {
            if (u.docChanged || u.selectionSet) report(u.view, 'a');
          }),
        ],
      },
      b: {
        doc: initial,
        extensions: [
          ...common('b'),
          labelB.current.of(codeMirrorContentLabel(t('panels.editor.conflict_diff.mine_label', { name }))),
          langB.current.of(lang()),
          EditorView.updateListener.of((u: ViewUpdate) => {
            if (u.docChanged && !suppressEmit.current) {
              const doc = u.state.doc;
              const next = doc.sliceString(0, doc.length, eolRef.current);
              lastSyncedRef.current = next;
              useEditorStore.getState().updateContent(tabId, next);
            }
            if (u.docChanged || u.selectionSet) report(u.view, 'b');
          }),
        ],
      },
      parent: host,
      highlightChanges: true,
      gutter: true,
      diffConfig: { scanLimit: 500, timeout: CONFLICT_DIFF_TIMEOUT_MS },
    });
    // 两侧在同一个滚动容器(.cm-mergeView,overflow-y: auto)里:MergeView 用占位对齐两侧行,一起滚动
    mv.dom.style.height = '100%';
    mvRef.current = mv;
    report(mv.b, 'b');
    // 焦点给右侧「你的版本」(VSCode 打开差异编辑器聚焦 modified 一侧):打开面板的通用聚焦落在内容里第一个可编辑区(左侧
    // 只读编辑器)或尚未落下(焦点在 body)时改到右侧;焦点在别处(用户已离开本面板)不抢。
    const doc = host.ownerDocument;
    const active = doc.activeElement;
    const panelRoot = host.closest('[data-conflict-diff-panel]');
    if (active === null || active === doc.body || (panelRoot?.contains(active) ?? false)) mv.b.focus();
    // 语言表里的语言包未加载 → 先纯文本,加载完两侧一起换上
    const desc = md ? null : languageDescriptionFor(filePath);
    if (desc && !desc.support) {
      desc.load().then(
        (support) => {
          if (mvRef.current !== mv) return;
          mv.a.dispatch({ effects: langA.current.reconfigure(support) });
          mv.b.dispatch({ effects: langB.current.reconfigure(support) });
        },
        () => {},
      );
    }
    // popout 弹出 / 收回只移动 DOM:按所在文档重绑 root(同 CodeEditor)
    const rebind = () => rebindCodeMirrorRoots(mv.dom);
    rebind();
    const unregisterRoot = registerEditorRootRebind(rebind);
    return () => {
      unregisterRoot();
      mv.destroy();
      mvRef.current = null;
    };
    // 只建一次;之后的内容 / 主题 / 语言变化走下面的 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 磁盘版本变化 → 左侧换成新内容(只派发变化段)
  useEffect(() => {
    const mv = mvRef.current;
    if (!mv) return;
    const cur = mv.a.state.doc.toString();
    const next = mv.a.state.toText(diskText).toString();
    if (cur === next) return;
    const change = minimalChange(cur, next) ?? { from: 0, to: cur.length, insert: next };
    mv.a.dispatch({ changes: change });
  }, [diskText]);

  // 原 tab 那边的编辑 / 程序化改内容 → 右侧套用(本视图输入的回声跳过)
  useEffect(() => {
    const mv = mvRef.current;
    if (!mv || content === null || content === lastSyncedRef.current) return;
    eolRef.current = detectLineEnding(content);
    lastSyncedRef.current = content;
    const cur = mv.b.state.doc.toString();
    const next = mv.b.state.toText(content).toString();
    if (cur === next) return;
    const change = minimalChange(cur, next) ?? { from: 0, to: cur.length, insert: next };
    suppressEmit.current = true;
    try {
      mv.b.dispatch({ changes: change });
    } finally {
      suppressEmit.current = false;
    }
  }, [content]);

  useEffect(() => {
    const mv = mvRef.current;
    if (!mv) return;
    const effects = themeCompartment.current.reconfigure(codeEditorTheme(resolved));
    mv.a.dispatch({ effects });
    mv.b.dispatch({ effects: themeCompartment.current.reconfigure(codeEditorTheme(resolved)) });
  }, [resolved]);

  useEffect(() => {
    const mv = mvRef.current;
    if (!mv) return;
    const name = basename(filePath);
    mv.a.dispatch({
      effects: [
        phrasesCompartment.current.reconfigure(codeMirrorPhrases()),
        labelA.current.reconfigure(codeMirrorContentLabel(t('panels.editor.conflict_diff.disk_label', { name }))),
      ],
    });
    mv.b.dispatch({
      effects: [
        phrasesCompartment.current.reconfigure(codeMirrorPhrases()),
        labelB.current.reconfigure(codeMirrorContentLabel(t('panels.editor.conflict_diff.mine_label', { name }))),
      ],
    });
  }, [locale, filePath]);

  useEffect(() => {
    const mv = mvRef.current;
    mv?.a.requestMeasure();
    mv?.b.requestMeasure();
  }, [fontSize]);

  return (
    <div
      ref={hostRef}
      data-conflict-diff-editors=""
      className="h-full w-full overflow-hidden bg-canvas"
      style={{ fontSize: `${fontSize}px` }}
    />
  );
}

const CHEVRON_UP = (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M4 10l4-4 4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const CHEVRON_DOWN = (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export interface ConflictDiffPanelProps {
  /** dockview 面板 params(只由 openConflictCompare 带上;缺失 / 畸形 → 找不到文档,不渲染)。 */
  readonly params?: Partial<ConflictDiffParams>;
}

export function ConflictDiffPanel({ params }: ConflictDiffPanelProps) {
  const tabId = typeof params?.tabId === 'string' ? params.tabId : '';
  const groupId = typeof params?.groupId === 'string' ? params.groupId : '';
  const tr = useT();
  const filePath = useEditorStore((s) => findEditorFileTabById(s.tabs, tabId)?.filePath ?? null);
  const realPath = useEditorStore((s) => findEditorFileTabById(s.tabs, tabId)?.realPath);
  const readEncoding = useEditorStore((s) => readOptionsForTab(findEditorFileTabById(s.tabs, tabId))?.encoding);
  const disk = useDiskVersion(filePath, realPath, readEncoding);
  const [busy, setBusy] = useState(false);
  const [chunks, setChunks] = useState<{ count: number; current: number }>({ count: 0, current: -1 });
  const navRef = useRef<((dir: 1 | -1) => void) | null>(null);
  const diskText = disk.kind === 'ok' ? disk.text : '';
  // 过大与否按磁盘版本到达时的两侧大小判定(编辑中不重算,免得输入跨过阈值时视图突然消失)
  const tooLarge = useMemo(() => {
    const mine = useEditorStore.getState().tabs.find((x) => x.id === tabId)?.content.length ?? 0;
    return isConflictDiffTooLarge(diskText.length, mine);
  }, [diskText, tabId]);
  const onChunksChanged = useCallback((count: number, current: number) => {
    setChunks((c) => (c.count === count && c.current === current ? c : { count, current }));
  }, []);

  const run = (choice: ConflictResolution): void => {
    if (busy) return;
    setBusy(true);
    void resolveConflict(tabId, groupId, choice).finally(() => setBusy(false));
  };

  if (filePath === null) return null; // 原 tab 已关闭:面板随即关闭(conflict-compare 自动关闭)
  const name = basename(filePath);
  const status =
    chunks.count === 0
      ? tr('panels.editor.conflict_diff.no_differences')
      : chunks.current >= 0
        ? tr('panels.editor.conflict_diff.position', { n: String(chunks.current + 1), total: String(chunks.count) })
        : translateCount('panels.editor.conflict_diff.count', chunks.count);
  const showDiff = disk.kind !== 'loading' && !tooLarge;

  return (
    <div className="flex h-full w-full flex-col bg-canvas" data-conflict-diff-panel="">
      <div
        role="toolbar"
        aria-label={tr('panels.editor.conflict_diff.toolbar')}
        className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2"
      >
        <IconButton
          aria-label={tr('panels.editor.conflict_diff.previous')}
          title={tr('panels.editor.conflict_diff.previous')}
          disabled={!showDiff || chunks.count === 0}
          onClick={() => navRef.current?.(-1)}
        >
          {CHEVRON_UP}
        </IconButton>
        <IconButton
          aria-label={tr('panels.editor.conflict_diff.next')}
          title={tr('panels.editor.conflict_diff.next')}
          disabled={!showDiff || chunks.count === 0}
          onClick={() => navRef.current?.(1)}
        >
          {CHEVRON_DOWN}
        </IconButton>
        {showDiff && <span className="truncate px-1 text-xs text-fg-muted">{status}</span>}
        <div className="min-w-0 flex-1" />
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => run('revert')}>
          {tr('panels.editor.conflict_diff.revert')}
        </Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => run('accept')}>
          {tr('panels.editor.conflict_diff.accept')}
        </Button>
      </div>
      {/* 两侧标题(VSCode 差异编辑器标题「{file} (in file) ↔ {file} (in Code)」拆到两栏上方) */}
      <div className="flex h-6 shrink-0 text-xs text-fg-muted" aria-hidden="true">
        <div className="min-w-0 flex-1 truncate border-r border-line px-3 leading-6">
          {tr('panels.editor.conflict_diff.disk_side', { name })}
        </div>
        <div className="min-w-0 flex-1 truncate px-3 leading-6">{tr('panels.editor.conflict_diff.mine_side', { name })}</div>
      </div>
      {disk.kind === 'error' && (
        <div role="status" className="bg-panel-soft px-4 py-2 text-xs text-fg-muted">
          {tr('panels.editor.conflict_diff.read_failed', { reason: localizeErrorByCode(disk.code, disk.message) })}
        </div>
      )}
      <div className="min-h-0 flex-1">
        {tooLarge ? (
          <div role="status" className="p-4 text-sm text-fg-muted">
            {tr('panels.editor.conflict_diff.too_large')}
          </div>
        ) : (
          showDiff && (
            <MergeHost
              tabId={tabId}
              filePath={filePath}
              diskText={diskText}
              onChunksChanged={onChunksChanged}
              navRef={navRef}
            />
          )
        )}
      </div>
    </div>
  );
}

export default ConflictDiffPanel;
