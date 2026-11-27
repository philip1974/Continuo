// CodeMirror 的「转到定义」(VSCode editor.action.revealDefinition + goToDefinitionAtPosition 的 ⌘ 单击 / ⌘ 悬停链接),接 TS / JS 语言服务。
// 只在 TS / JS 文件上生效(ts / tsx / js / jsx / mts / cts / mjs / cjs,有磁盘路径;Markdown 代码块与其它语言不变):
// - F12 / 右键「转到定义」/ 命令面板:按光标处请求(见 revealDefinitionWithService);
// - ⌘ 单击(mac)/ Ctrl 单击(Windows / Linux):按下照常移动光标(VSCode 同),松开且没拖动 → 按该处请求;没有定义 → 静默。
//   ⌥ 单击加光标不变;不在单词上不做事;
// - 按住 ⌘ / Ctrl 悬停在单词上:请求该处定义,有 → 下划线 + 手型指针(VSCode 的 link 装饰,范围 = 语言服务给的标识符区间);
//   松开修饰键 / 移开 / 失焦 / 编辑 → 消失。同槽请求新的取消旧的(main 侧),迟到的结果按代际丢弃。
// 打开 TS / JS 文件(视图创建)即预热语言服务(VSCode 打开 TS 文件即启动 tsserver)。
// BDD: src/__tests__/editor-go-to-definition/

import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { Facet, StateEffect, StateField, type Extension, type Text } from '@codemirror/state';
import { detectPlatform } from '@/plugins/command-palette/format-hotkey';
import type { TsLocation, TsRange } from '../../../electron/shared/ts-language';
import { isTsLanguageDocument, requestTsLanguage, warmTsLanguage } from './ts-language-client';
import { handleDefinitionReply, showLocations } from './go-to-definition';

/** 编辑器的文档路径(CodeEditor 登记;取最新值:标签改名后路径会变)。未登记 → 没有转到定义。 */
const definitionDocumentPath = Facet.define<() => string, (() => string) | null>({
  combine: (values) => values[0] ?? null,
});

/** 视图对应的、语言服务能处理的文件路径;不能 → null。 */
export function definitionPathOf(view: EditorView): string | null {
  const p = view.state.facet(definitionDocumentPath)?.();
  return p !== undefined && isTsLanguageDocument(p) ? p : null;
}

/** 该编辑器是否有转到定义(右键菜单据此显示「转到定义」)。 */
export function supportsGoToDefinition(view: EditorView): boolean {
  return definitionPathOf(view) !== null;
}

/** 修饰键(VSCode editor.multiCursorModifier = alt 时,打开定义的是 ⌘ / Ctrl)。 */
export function isDefinitionModifier(
  e: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  mac: boolean = detectPlatform() === 'mac',
): boolean {
  if (e.altKey || e.shiftKey) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

function isModifierKey(key: string, mac: boolean): boolean {
  return mac ? key === 'Meta' : key === 'Control';
}

function lineColumnOf(doc: Text, pos: number): { line: number; column: number } {
  const line = doc.lineAt(pos);
  return { line: line.number, column: pos - line.from + 1 };
}

/** 1 起行列区间 → 文档位置(越界收进文档);空区间 / 不合法 → null。 */
export function rangeToPositions(doc: Text, r: TsRange): { from: number; to: number } | null {
  const posOf = (line: number, column: number): number => {
    const l = doc.line(Math.min(Math.max(line, 1), doc.lines));
    return l.from + Math.min(Math.max(column - 1, 0), l.length);
  };
  const from = posOf(r.line, r.column);
  const to = posOf(r.endLine, r.endColumn);
  return to > from ? { from, to } : null;
}

function wordAt(view: EditorView, pos: number): { from: number; to: number } | null {
  return view.state.wordAt(pos);
}

/** pos 处请求定义(命令槽)并处理结果。mute = ⌘ 单击(无结果不提示)。 */
async function definitionAt(view: EditorView, path: string, pos: number, mute: boolean): Promise<void> {
  const word = wordAt(view, pos);
  const name = word ? view.state.sliceDoc(word.from, word.to) : undefined;
  const reply = await requestTsLanguage({ kind: 'definition', slot: 'command', path, ...lineColumnOf(view.state.doc, pos) });
  handleDefinitionReply(reply, name, mute);
}

/**
 * F12 / 右键 / 命令面板的转到定义:该编辑器有语言服务 → 按光标请求,返回 true;没有 → false(调用方按无语言服务的提示处理)。
 */
export function revealDefinitionWithService(view: EditorView): boolean {
  const path = definitionPathOf(view);
  if (path === null) return false;
  void definitionAt(view, path, view.state.selection.main.head, false);
  return true;
}

// ---- ⌘ 悬停的链接装饰 ----

const setDefinitionLink = StateEffect.define<{ from: number; to: number } | null>();
const linkMark = Decoration.mark({ class: 'cm-definition-link' });

const definitionLinkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setDefinitionLink)) return e.value ? Decoration.set([linkMark.range(e.value.from, e.value.to)]) : Decoration.none;
    }
    return tr.docChanged ? Decoration.none : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** 当前链接装饰的区间(无 → null)。 */
export function definitionLinkRange(view: EditorView): { from: number; to: number } | null {
  let out: { from: number; to: number } | null = null;
  view.state.field(definitionLinkField, false)?.between(0, view.state.doc.length, (from, to) => {
    out = { from, to };
  });
  return out;
}

const HOVER_DELAY_MS = 30;
const CLICK_SLOP_PX = 4;

class DefinitionLinkPlugin {
  private readonly mac = detectPlatform() === 'mac';
  private mouse: { x: number; y: number } | null = null;
  /** 正在请求 / 已装饰的单词区间(同一单词内移动不重复请求)。 */
  private word: { from: number; to: number } | null = null;
  /** 悬停得到的结果(⌘ 单击在同一处直接用)。 */
  private result: { doc: Text; from: number; to: number; definitions: readonly TsLocation[] } | null = null;
  private gen = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private down: { x: number; y: number; pos: number } | null = null;

  constructor(private readonly view: EditorView) {
    const path = definitionPathOf(view);
    if (path !== null) warmTsLanguage(path);
  }

  update(u: ViewUpdate): void {
    if (u.docChanged) this.reset();
  }

  destroy(): void {
    this.gen++;
    if (this.timer !== null) clearTimeout(this.timer);
  }

  private reset(): void {
    this.gen++;
    this.word = null;
    this.result = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 去掉链接装饰(并作废在途的悬停请求)。 */
  clear(): void {
    this.reset();
    if (definitionLinkRange(this.view) !== null) this.view.dispatch({ effects: setDefinitionLink.of(null) });
  }

  private posAt(x: number, y: number): number | null {
    return this.view.posAtCoords({ x, y });
  }

  /** 按住修饰键时鼠标所在位置:在单词上 → 请求;否则清掉。 */
  check(): void {
    const path = definitionPathOf(this.view);
    if (path === null || this.mouse === null) return;
    const pos = this.posAt(this.mouse.x, this.mouse.y);
    const word = pos === null ? null : wordAt(this.view, pos);
    if (pos === null || word === null) {
      this.clear();
      return;
    }
    if (this.word && this.word.from === word.from && this.word.to === word.to) return;
    this.clear();
    this.word = word;
    const my = this.gen;
    const doc = this.view.state.doc;
    this.timer = setTimeout(() => {
      this.timer = null;
      void requestTsLanguage({ kind: 'definition', slot: 'hover', path, ...lineColumnOf(doc, pos) }).then((reply) => {
        if (my !== this.gen || this.view.state.doc !== doc) return;
        if (reply.status !== 'ok' || reply.definitions.length === 0) return;
        const range = (reply.origin && rangeToPositions(doc, reply.origin)) ?? word;
        this.result = { doc, ...range, definitions: reply.definitions };
        this.view.dispatch({ effects: setDefinitionLink.of(range) });
      });
    }, HOVER_DELAY_MS);
  }

  mousemove(e: MouseEvent): void {
    const held = isDefinitionModifier(e, this.mac);
    // 原地的 mousemove(Chromium 在布局 / 装饰变化后补发,修饰键状态不可靠)不算移开:松开修饰键由 keyup 处理
    if (!held && this.mouse !== null && this.mouse.x === e.clientX && this.mouse.y === e.clientY) return;
    this.mouse = { x: e.clientX, y: e.clientY };
    if (held) this.check();
    else if (this.word !== null || definitionLinkRange(this.view) !== null) this.clear();
  }

  keydown(e: KeyboardEvent): void {
    if (isModifierKey(e.key, this.mac)) this.check();
    else if (this.word !== null) this.clear();
  }

  keyup(e: KeyboardEvent): void {
    if (isModifierKey(e.key, this.mac)) this.clear();
  }

  mouseleave(): void {
    this.mouse = null;
    this.clear();
  }

  mousedown(e: MouseEvent): void {
    this.down = null;
    if (e.button !== 0 || !isDefinitionModifier(e, this.mac) || definitionPathOf(this.view) === null) return;
    const pos = this.posAt(e.clientX, e.clientY);
    if (pos === null || wordAt(this.view, pos) === null) return;
    this.down = { x: e.clientX, y: e.clientY, pos };
  }

  mouseup(e: MouseEvent): void {
    const down = this.down;
    this.down = null;
    if (!down || e.button !== 0 || !isDefinitionModifier(e, this.mac)) return;
    if (Math.abs(e.clientX - down.x) > CLICK_SLOP_PX || Math.abs(e.clientY - down.y) > CLICK_SLOP_PX) return; // 拖动选择
    const path = definitionPathOf(this.view);
    if (path === null) return;
    const r = this.result;
    if (r && r.doc === this.view.state.doc && down.pos >= r.from && down.pos <= r.to) {
      this.clear();
      showLocations(r.definitions);
      return;
    }
    this.clear();
    void definitionAt(this.view, path, down.pos, true);
  }
}

const definitionLinkPlugin = ViewPlugin.fromClass(DefinitionLinkPlugin, {
  eventObservers: {
    mousemove(e) {
      this.mousemove(e);
    },
    mouseleave() {
      this.mouseleave();
    },
    mousedown(e) {
      this.mousedown(e);
    },
    mouseup(e) {
      this.mouseup(e);
    },
    keydown(e) {
      this.keydown(e);
    },
    keyup(e) {
      this.keyup(e);
    },
    blur() {
      this.clear();
    },
  },
});

const definitionLinkTheme = EditorView.baseTheme({
  '.cm-definition-link': {
    textDecoration: 'underline',
    cursor: 'pointer',
    color: 'var(--md-primary)',
  },
});

/** CodeEditor 的扩展:getPath = 当前文档路径(非 TS / JS 文件时整个扩展不做事)。 */
export function goToDefinitionExtension(getPath: () => string): Extension {
  return [definitionDocumentPath.of(getPath), definitionLinkField, definitionLinkPlugin, definitionLinkTheme];
}
