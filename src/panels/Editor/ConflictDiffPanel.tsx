// 保存冲突差异 tab(VSCode「{file} (in file) ↔ {file} (in Code)」差异编辑器;懒加载 chunk,含 @codemirror/merge)。
//
// - 布局:差异区宽 > 900 左右并排(MergeView);≤ 900 单栏内联(unifiedMergeView,VSCode diffEditor.useInlineViewWhenSpaceIsLimited),
//   宽度跨过阈值时重建视图 —— 「你的版本」就是 store 里的文档,重建只换视图,内容 / 光标 / 焦点照旧。
// - 左:磁盘当前内容,只读(可聚焦、可选中复制);磁盘再次变化(dir-changed 命中该文件 / watcher 恢复)→ 重读并更新。
// - 右:你的版本 = 编辑器 store 里的同一文档:这里输入即改原 tab(原 tab 同步变脏 / 变化),原 tab 里的编辑也同步过来。
// - 逐行高亮 + 行内差异(@codemirror/merge highlightChanges);上一处 / 下一处差异(工具栏按钮,编辑器内 Alt+F5 / Shift+Alt+F5,
//   同 VSCode workbench.action.compareEditor.nextChange / previousChange),导航后读屏播报「第 n 处差异(共 m 处),第 L 行」。
// - 接受我的版本 / 使用磁盘版本(见 conflict-compare resolveConflict)。
// - 两侧合计过大(CONFLICT_DIFF_MAX_CHARS)不计算差异,只显示提示;差异计算另有单次超时。
// Markdown 按源码文本比较(markdown 高亮)。BDD: src/__tests__/editor-save-conflict-compare/

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  MergeView,
  getChunks,
  getOriginalDoc,
  goToNextChunk,
  goToPreviousChunk,
  originalDocChangeEffect,
  unifiedMergeView,
} from '@codemirror/merge';
import { ChangeSet, Compartment, EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state';
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
import { detectLineEnding, languageDescriptionFor, pickLanguage } from './CodeEditor';
import { minimalChange } from './minimal-change';
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
  conflictDiffLayoutFor,
  dirChangeTouchesFile,
  isConflictDiffTooLarge,
  type ConflictDiffLayout,
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

/**
 * 增删指示符(VSCode diffEditor.renderIndicators 默认开:删除行 gutter 画 codicon diff-remove「−」、新增行 diff-insert「+」,
 * 并排与内联两种布局都有):画在 @codemirror/merge 的变更 gutter 里,色盲 / 强制颜色下不只靠红绿底色区分。
 * 字形用 mask(颜色 = currentColor = git 装饰色);每个符号高 1lh,纵向重复 —— 内联布局的一整块删除行只有一个 gutter 元素,
 * 照样每行一个「−」(VSCode 每行一个)。SVG 只作遮罩形状,fill / stroke 的颜色不参与显示。
 */
const indicatorMask = (path: string): string =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path d='${path}' stroke='black' stroke-width='1.4' stroke-linecap='round' fill='none'/></svg>`,
  )}")`;
/** 删除行「−」/ 新增行「+」的遮罩(导出供规范钉住形状不同)。 */
export const DIFF_REMOVE_INDICATOR = indicatorMask('M3.5 6h5');
export const DIFF_INSERT_INDICATOR = indicatorMask('M3.5 6h5M6 3.5v5');

const indicator = (mask: string) => ({
  content: '""',
  position: 'absolute',
  inset: '0',
  backgroundColor: 'currentColor',
  maskImage: mask,
  maskRepeat: 'repeat-y',
  maskPosition: 'center top',
  maskSize: '100% 1lh',
});

/** 差异配色:取 git 装饰 token(已在亮 / 暗两套主题里给值),整行淡底 + 行内较深底;gutter 淡底 + 「−」/「+」指示符。 */
const diffTheme = EditorView.theme({
  '&.cm-merge-a .cm-changedLine': { backgroundColor: 'color-mix(in srgb, var(--md-git-deleted) 12%, transparent)' },
  '&.cm-merge-b .cm-changedLine': { backgroundColor: 'color-mix(in srgb, var(--md-git-added) 12%, transparent)' },
  '&.cm-merge-a .cm-changedText': { background: 'color-mix(in srgb, var(--md-git-deleted) 34%, transparent)' },
  '&.cm-merge-b .cm-changedText': { background: 'color-mix(in srgb, var(--md-git-added) 34%, transparent)' },
  // 变更 gutter:库默认 3px 实色条 → 12px 宽、与该行同样的淡底,里面画指示符(VSCode 的 gutter-insert / gutter-delete 底色 +
  // insert-sign / delete-sign)
  '.cm-changeGutter': { width: '12px', paddingLeft: '0' },
  '.cm-changeGutter .cm-gutterElement': { position: 'relative' },
  '&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter': {
    background: 'color-mix(in srgb, var(--md-git-deleted) 12%, transparent)',
    color: 'var(--md-git-deleted)',
  },
  '&.cm-merge-b .cm-changedLineGutter': {
    background: 'color-mix(in srgb, var(--md-git-added) 12%, transparent)',
    color: 'var(--md-git-added)',
  },
  '&.cm-merge-a .cm-changedLineGutter::before, .cm-deletedLineGutter::before': indicator(DIFF_REMOVE_INDICATOR),
  '&.cm-merge-b .cm-changedLineGutter::before': indicator(DIFF_INSERT_INDICATOR),
  // 单栏内联:磁盘版本被删 / 改掉的行(只读块)与其中的行内差异,配色同左侧
  '.cm-deletedChunk': { backgroundColor: 'color-mix(in srgb, var(--md-git-deleted) 12%, transparent)' },
  '.cm-deletedChunk .cm-deletedText': { background: 'color-mix(in srgb, var(--md-git-deleted) 34%, transparent)' },
  // 两侧之间的分隔线
  '&.cm-merge-a': { borderRight: '1px solid var(--md-outline-variant)' },
  '.cm-content': { padding: '8px 0' },
  // 强制颜色(高对比度):底色被抹掉,行内差异改画轮廓仍可辨;gutter 保住指示符(forced-color-adjust: none + 系统色:
  // Canvas 底上 CanvasText 的「−」/「+」)
  '@media (forced-colors: active)': {
    '.cm-changedText': { outline: '1px solid CanvasText' },
    // 选择器与上面的配色规则同优先级(主题类 + 两个类),后写者胜。@media 块里不能用 &(EditorView.theme 会把 & 换成
    // 「@media …」本身,生成无效选择器),故用 .cm-changeGutter 补足优先级。
    '.cm-changeGutter .cm-changedLineGutter, .cm-changeGutter .cm-deletedLineGutter': {
      forcedColorAdjust: 'none',
      background: 'Canvas',
      color: 'CanvasText',
    },
  },
});

/** 当前视图:并排时 a = 磁盘(只读)、b = 你的版本;内联时只有 b(原文 = 磁盘版本)。 */
interface DiffViews {
  readonly a: EditorView | null;
  readonly b: EditorView;
  /** 外层 DOM(popout 重绑 root 用)。 */
  readonly dom: HTMLElement;
  destroy(): void;
}

interface MergeHostProps {
  readonly layout: ConflictDiffLayout;
  readonly tabId: string;
  readonly filePath: string;
  readonly diskText: string;
  /** 导航 / 差异变化后刷新工具栏状态。 */
  readonly onChunksChanged: (count: number, current: number) => void;
  /** 父组件经此拿到导航函数(工具栏按钮用)。 */
  readonly navRef: React.MutableRefObject<((dir: 1 | -1) => void) | null>;
}

function MergeHost({ layout, tabId, filePath, diskText, onChunksChanged, navRef }: MergeHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mvRef = useRef<DiffViews | null>(null);
  /** 换布局重建前「你的版本」的选区(按当前文档长度夹取后带进新视图)。 */
  const selectionRef = useRef<EditorSelection | null>(null);
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
  /** 换布局卸载旧视图时焦点是否在差异编辑器里(重建后据此把焦点还给「你的版本」)。 */
  const prevHadFocusRef = useRef(false);
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
      const side = mv.a === null ? 'b' : from ? (from === mv.a ? 'a' : 'b') : lastFocusedRef.current;
      const view = side === 'a' && mv.a !== null ? mv.a : mv.b;
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
    // 「你的版本」= store 里的文档(换布局重建时也从这里取:视图里的每次输入都已同步写进 store)
    const initial = useEditorStore.getState().tabs.find((x) => x.id === tabId)?.content ?? '';
    eolRef.current = detectLineEnding(initial);
    lastSyncedRef.current = initial;
    // 换布局重建:旧视图里的焦点 / 选区带到新的「你的版本」
    const prev = selectionRef.current;
    selectionRef.current = null;
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
    const mineExtensions: Extension[] = [
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
    ];
    const diffConfig = { scanLimit: 500, timeout: CONFLICT_DIFF_TIMEOUT_MS };
    const initialDoc = EditorState.create({ doc: initial }).doc;
    const selection = prev && prev.main.head <= initialDoc.length && prev.main.anchor <= initialDoc.length ? prev : undefined;
    let views: DiffViews;
    if (layout === 'split') {
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
        b: { doc: initialDoc, ...(selection ? { selection } : {}), extensions: mineExtensions },
        parent: host,
        highlightChanges: true,
        gutter: true,
        diffConfig,
      });
      // 两侧在同一个滚动容器(.cm-mergeView,overflow-y: auto)里:MergeView 用占位对齐两侧行,一起滚动
      mv.dom.style.height = '100%';
      views = { a: mv.a, b: mv.b, dom: mv.dom, destroy: () => mv.destroy() };
    } else {
      // 单栏内联:磁盘版本被删 / 改掉的行以只读块显示在你的版本上方;不要逐块接受 / 拒绝按钮(动作在工具栏,同并排布局)
      const view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: initialDoc,
          ...(selection ? { selection } : {}),
          extensions: [
            ...mineExtensions,
            unifiedMergeView({ original: diskText, highlightChanges: true, gutter: true, mergeControls: false, diffConfig }),
          ],
        }),
      });
      view.dom.style.height = '100%';
      lastFocusedRef.current = 'b';
      views = { a: null, b: view, dom: view.dom, destroy: () => view.destroy() };
    }
    mvRef.current = views;
    report(views.b, 'b');
    // 换布局重建:光标所在处滚回可见(新视图从顶部开始)
    if (selection) views.b.dispatch({ effects: EditorView.scrollIntoView(selection.main.head, { y: 'center' }) });
    // 焦点给右侧「你的版本」(VSCode 打开差异编辑器聚焦 modified 一侧):打开面板的通用聚焦落在内容里第一个可编辑区(左侧
    // 只读编辑器)或尚未落下(焦点在 body)时改到右侧;焦点在别处(用户已离开本面板)不抢。换布局重建时旧视图已随卸载移除,
    // 焦点落回 body,同样回到「你的版本」(此前焦点在面板外则不抢)。
    const doc = host.ownerDocument;
    const active = doc.activeElement;
    const panelRoot = host.closest('[data-conflict-diff-panel]');
    const hadFocus = prev !== null ? prevHadFocusRef.current : true;
    prevHadFocusRef.current = false;
    if (hadFocus && (active === null || active === doc.body || (panelRoot?.contains(active) ?? false))) views.b.focus();
    // 语言表里的语言包未加载 → 先纯文本,加载完一起换上
    const desc = md ? null : languageDescriptionFor(filePath);
    if (desc && !desc.support) {
      desc.load().then(
        (support) => {
          if (mvRef.current !== views) return;
          views.a?.dispatch({ effects: langA.current.reconfigure(support) });
          views.b.dispatch({ effects: langB.current.reconfigure(support) });
        },
        () => {},
      );
    }
    // popout 弹出 / 收回只移动 DOM:按所在文档重绑 root(同 CodeEditor)
    const rebind = () => rebindCodeMirrorRoots(views.dom);
    rebind();
    const unregisterRoot = registerEditorRootRebind(rebind);
    return () => {
      unregisterRoot();
      // 换布局 / 卸载:记下「你的版本」的选区与焦点,重建时带过去
      selectionRef.current = views.b.state.selection;
      const focusedEl = host.ownerDocument.activeElement;
      prevHadFocusRef.current = focusedEl !== null && views.dom.contains(focusedEl);
      views.destroy();
      mvRef.current = null;
    };
    // 只在布局变化时重建;之后的内容 / 主题 / 语言变化走下面的 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  // 磁盘版本变化 → 左侧换成新内容(只派发变化段)
  useEffect(() => {
    const mv = mvRef.current;
    if (!mv) return;
    if (mv.a !== null) {
      const cur = mv.a.state.doc.toString();
      const next = mv.a.state.toText(diskText).toString();
      if (cur === next) return;
      const change = minimalChange(cur, next) ?? { from: 0, to: cur.length, insert: next };
      mv.a.dispatch({ changes: change });
      return;
    }
    // 内联:原文(磁盘版本)以 effect 更新
    const original = getOriginalDoc(mv.b.state);
    const cur = original.toString();
    const next = mv.b.state.toText(diskText).toString();
    if (cur === next) return;
    const change = minimalChange(cur, next) ?? { from: 0, to: cur.length, insert: next };
    mv.b.dispatch({ effects: originalDocChangeEffect(mv.b.state, ChangeSet.of(change, original.length)) });
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
    mv.a?.dispatch({ effects: themeCompartment.current.reconfigure(codeEditorTheme(resolved)) });
    mv.b.dispatch({ effects: themeCompartment.current.reconfigure(codeEditorTheme(resolved)) });
  }, [resolved]);

  useEffect(() => {
    const mv = mvRef.current;
    if (!mv) return;
    const name = basename(filePath);
    mv.a?.dispatch({
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
    mv?.a?.requestMeasure();
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
  // 差异区宽度 → 并排 / 内联(挂载时同步量一次,首帧即是正确布局;之后随 ResizeObserver 切换)
  const bodyRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<ConflictDiffLayout | null>(null);
  const hasFile = filePath !== null;
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setLayout((cur) => conflictDiffLayoutFor(el.getBoundingClientRect().width, cur ?? 'split'));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasFile]);

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
      {/* 窄宽:按钮组整体换到下一行(靠右),仍放不下(组宽 < 单个按钮)再横向滚动;不固定高度,换行时不盖住下方代码 */}
      <div
        role="toolbar"
        aria-label={tr('panels.editor.conflict_diff.toolbar')}
        className="flex min-h-9 shrink-0 flex-wrap items-center gap-1 overflow-x-auto border-b border-line px-2 py-0.5"
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
        {showDiff && <span className="min-w-0 truncate px-1 text-xs text-fg-muted">{status}</span>}
        <div className="ml-auto flex shrink-0 flex-wrap justify-end gap-1">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => run('revert')}>
            {tr('panels.editor.conflict_diff.revert')}
          </Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => run('accept')}>
            {tr('panels.editor.conflict_diff.accept')}
          </Button>
        </div>
      </div>
      {/* 两侧标题(VSCode 差异编辑器标题「{file} (in file) ↔ {file} (in Code)」拆到两栏上方;内联时合成一行) */}
      <div className="flex h-6 shrink-0 text-xs text-fg-muted" aria-hidden="true" data-conflict-diff-sides="">
        {layout === 'unified' ? (
          <div className="min-w-0 flex-1 truncate px-3 leading-6">
            {`${tr('panels.editor.conflict_diff.disk_side', { name })} ↔ ${tr('panels.editor.conflict_diff.mine_side', { name })}`}
          </div>
        ) : (
          <>
            <div className="min-w-0 flex-1 truncate border-r border-line px-3 leading-6">
              {tr('panels.editor.conflict_diff.disk_side', { name })}
            </div>
            <div className="min-w-0 flex-1 truncate px-3 leading-6">{tr('panels.editor.conflict_diff.mine_side', { name })}</div>
          </>
        )}
      </div>
      {disk.kind === 'error' && (
        <div role="status" className="bg-panel-soft px-4 py-2 text-xs text-fg-muted">
          {tr('panels.editor.conflict_diff.read_failed', { reason: localizeErrorByCode(disk.code, disk.message) })}
        </div>
      )}
      <div ref={bodyRef} className="min-h-0 flex-1" data-conflict-diff-body="">
        {tooLarge ? (
          <div role="status" className="p-4 text-sm text-fg-muted">
            {tr('panels.editor.conflict_diff.too_large')}
          </div>
        ) : (
          showDiff &&
          layout !== null && (
            <MergeHost
              layout={layout}
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
