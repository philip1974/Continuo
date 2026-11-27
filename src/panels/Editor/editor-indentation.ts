// 文档缩进(VSCode 文本模型选项 tabSize / insertSpaces):打开文档时按设置 + 语言默认 + 内容推断(editor.detectIndentation)
// 定一次,按 tab 记在本模块(会话内;同一文档跨编辑器组共享,关闭 / 改名即丢弃 —— VSCode 文本模型随之销毁,重开重新推断)。
// CodeEditor 据此配置 indentUnit / EditorState.tabSize(回车自动缩进、Tab / ⇧Tab、⌘] / ⌘[ 都按它);状态栏缩进项与
// 「使用空格缩进 / 使用 Tab 缩进 / 从内容中检测缩进方式 / 将缩进转换为空格 / 制表符」改它。
// 三个设置变化 → 所有打开的文档按新设置重新确定(VSCode ModelService._updateModelOptions 同)。
// BDD: src/__tests__/editor-indentation/

// 纯数据 + store,不 import CodeMirror(状态栏 / 命令在主 bundle;CodeMirror 只在编辑器懒加载 chunk 里)。

import { create } from 'zustand';
import {
  EDITOR_DETECT_INDENTATION,
  EDITOR_INSERT_SPACES,
  EDITOR_TAB_SIZE,
} from '@/plugins/settings/core-setting-specs';
import { getStoredSettingValue, useSettingsValuesStore } from '@/plugins/settings/values-store';
import { useEditorStore } from '@/stores/editor.store';
import { lastSeparatorIndex } from '@/lib/path-cross';
import { guessIndentation } from './indentation-guesser';

export interface IndentOptions {
  /** 一级缩进的空格数(insertSpaces)/ tab 显示宽度。 */
  readonly tabSize: number;
  readonly insertSpaces: boolean;
}

/** editor.tabSize 的取值范围(VSCode 同:1..100)。 */
export const MIN_TAB_SIZE = 1;
export const MAX_TAB_SIZE = 100;

function clampTabSize(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(MAX_TAB_SIZE, Math.max(MIN_TAB_SIZE, Math.round(v)));
}

function boolSetting(id: string, fallback: boolean): boolean {
  const v = getStoredSettingValue(id);
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * 语言默认(VSCode 内置扩展 configurationDefaults):Makefile(extensions/make)与 Go(extensions/go)`editor.insertSpaces: false`。
 * 语言识别同 VSCode:makefile = Makefile / makefile / GNUmakefile / OCamlMakefile、.mk / .mak;go = .go。
 */
export function languageInsertSpacesDefault(filePath: string): boolean | undefined {
  const base = filePath.slice(lastSeparatorIndex(filePath) + 1);
  if (/^(?:makefile|gnumakefile|ocamlmakefile)$/i.test(base) || /\.(?:mk|mak)$/i.test(base)) return false;
  if (/\.go$/i.test(base)) return false;
  return undefined;
}

/** 三个缩进设置的值(editor.tabSize / editor.insertSpaces / editor.detectIndentation)。 */
export interface IndentSettings {
  readonly tabSize: number;
  readonly insertSpaces: boolean;
  readonly detectIndentation: boolean;
}

/** 当前设置值(未存 → 默认)。组件里用 useSettingValue 取同样三项传入(随设置重渲)。 */
export function readIndentSettings(): IndentSettings {
  return {
    tabSize: clampTabSize(getStoredSettingValue(EDITOR_TAB_SIZE.id), EDITOR_TAB_SIZE.default),
    insertSpaces: boolSetting(EDITOR_INSERT_SPACES.id, EDITOR_INSERT_SPACES.default),
    detectIndentation: boolSetting(EDITOR_DETECT_INDENTATION.id, EDITOR_DETECT_INDENTATION.default),
  };
}

/** 文档创建时的缩进默认(VSCode getCreationOptions):设置值,语言默认覆盖 insertSpaces。 */
export function creationIndentOptions(
  filePath: string,
  settings: IndentSettings = readIndentSettings(),
): IndentOptions & { readonly detectIndentation: boolean } {
  return {
    tabSize: clampTabSize(settings.tabSize, EDITOR_TAB_SIZE.default),
    insertSpaces: languageInsertSpacesDefault(filePath) ?? settings.insertSpaces,
    detectIndentation: settings.detectIndentation,
  };
}

/** 按设置确定文档缩进:开了 detectIndentation → 以设置为默认值推断内容(VSCode TextModel 创建时同)。 */
export function resolveIndentation(filePath: string, content: string, settings?: IndentSettings): IndentOptions {
  const opts = creationIndentOptions(filePath, settings);
  if (!opts.detectIndentation) return { tabSize: opts.tabSize, insertSpaces: opts.insertSpaces };
  return guessIndentation(content, opts.tabSize, opts.insertSpaces);
}

/** 「从内容中检测缩进方式」:总是按内容推断(不看 detectIndentation 设置;VSCode DetectIndentation 同)。 */
export function detectIndentationFromContent(filePath: string, content: string): IndentOptions {
  const opts = creationIndentOptions(filePath);
  return guessIndentation(content, opts.tabSize, opts.insertSpaces);
}

interface IndentationState {
  readonly byTab: ReadonlyMap<string, IndentOptions>;
}

export const useIndentationStore = create<IndentationState>(() => ({ byTab: new Map() }));

function sameIndent(a: IndentOptions | undefined, b: IndentOptions): boolean {
  return a !== undefined && a.tabSize === b.tabSize && a.insertSpaces === b.insertSpaces;
}

/** 设定某文档的缩进(相同则不动)。 */
export function setTabIndentation(tabId: string, opts: IndentOptions): void {
  const next: IndentOptions = { tabSize: clampTabSize(opts.tabSize, EDITOR_TAB_SIZE.default), insertSpaces: opts.insertSpaces };
  const { byTab } = useIndentationStore.getState();
  if (sameIndent(byTab.get(tabId), next)) return;
  const map = new Map(byTab);
  map.set(tabId, next);
  useIndentationStore.setState({ byTab: map });
}

export function tabIndentationOf(tabId: string): IndentOptions | undefined {
  return useIndentationStore.getState().byTab.get(tabId);
}

/** 文档的缩进:已确定过 → 原值(会话内不随编辑重新推断);否则现在按内容确定并记下。 */
export function ensureTabIndentation(
  tabId: string,
  filePath: string,
  content: string,
  settings?: IndentSettings,
): IndentOptions {
  const existing = tabIndentationOf(tabId);
  if (existing) return existing;
  const resolved = resolveIndentation(filePath, content, settings);
  setTabIndentation(tabId, resolved);
  return resolved;
}

export function useTabIndentation(tabId: string | null): IndentOptions | undefined {
  return useIndentationStore((s) => (tabId === null ? undefined : s.byTab.get(tabId)));
}

/** 一级缩进单位(CodeMirror indentUnit):空格 × tabSize / 一个 tab。 */
export function indentUnitText(opts: IndentOptions): string {
  return opts.insertSpaces ? ' '.repeat(opts.tabSize) : '\t';
}

/**
 * 整篇缩进转换(VSCode getIndentationEditOperations):每行行首空白里,转空格 = 每个 tab 换成 tabSize 个空格;转 tab = 每 tabSize
 * 个连续空格换成一个 tab(余下不足一级的空格保留)。返回按行的替换(文档坐标,from 递增),无变化的行不列。
 */
export function indentationConversionChanges(
  lines: Iterable<{ readonly from: number; readonly text: string }>,
  tabSize: number,
  toSpaces: boolean,
): { from: number; to: number; insert: string }[] {
  const spaces = ' '.repeat(tabSize);
  const changes: { from: number; to: number; insert: string }[] = [];
  for (const line of lines) {
    const indent = /^[ \t]*/.exec(line.text)![0];
    if (indent.length === 0) continue;
    const next = toSpaces ? indent.replace(/\t/g, spaces) : indent.split(spaces).join('\t');
    if (next !== indent) changes.push({ from: line.from, to: line.from + indent.length, insert: next });
  }
  return changes;
}

/** 字符串版(无编辑器视图时用):返回转换后的全文。行尾原样保留。 */
export function convertIndentationText(text: string, tabSize: number, toSpaces: boolean): string {
  const lines: { from: number; text: string }[] = [];
  const re = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && m[0].length > 0) {
    lines.push({ from: m.index, text: m[0] });
  }
  const changes = indentationConversionChanges(lines, tabSize, toSpaces);
  if (changes.length === 0) return text;
  let out = '';
  let pos = 0;
  for (const c of changes) {
    out += text.slice(pos, c.from) + c.insert;
    pos = c.to;
  }
  return out + text.slice(pos);
}

let lastSettingsKey: string | null = null;

function settingsKey(): string {
  return [
    getStoredSettingValue(EDITOR_TAB_SIZE.id),
    getStoredSettingValue(EDITOR_INSERT_SPACES.id),
    getStoredSettingValue(EDITOR_DETECT_INDENTATION.id),
  ].join('\u0000');
}

/**
 * 安装:①三个缩进设置变化 → 已打开文档全部按新设置重新确定(VSCode 同,含用户在选择器里选过的);②文档关闭 / 改名(tab id
 * 不在了)→ 丢弃其缩进记录。返回取消订阅。
 */
export function installIndentationSync(): () => void {
  lastSettingsKey = settingsKey();
  const offSettings = useSettingsValuesStore.subscribe(() => {
    const key = settingsKey();
    if (key === lastSettingsKey) return;
    lastSettingsKey = key;
    const { byTab } = useIndentationStore.getState();
    if (byTab.size === 0) return;
    const tabs = useEditorStore.getState().tabs;
    const map = new Map<string, IndentOptions>();
    for (const id of byTab.keys()) {
      const tab = tabs.find((t) => t.id === id);
      if (tab) map.set(id, resolveIndentation(tab.filePath, tab.content));
    }
    useIndentationStore.setState({ byTab: map });
  });
  let lastTabs = useEditorStore.getState().tabs;
  const offTabs = useEditorStore.subscribe((s) => {
    if (s.tabs === lastTabs) return;
    lastTabs = s.tabs;
    const { byTab } = useIndentationStore.getState();
    if (byTab.size === 0) return;
    const ids = new Set(s.tabs.map((t) => t.id));
    let map: Map<string, IndentOptions> | null = null;
    for (const id of byTab.keys()) {
      if (ids.has(id)) continue;
      map ??= new Map(byTab);
      map.delete(id);
    }
    if (map) useIndentationStore.setState({ byTab: map });
  });
  return () => {
    offSettings();
    offTabs();
  };
}
