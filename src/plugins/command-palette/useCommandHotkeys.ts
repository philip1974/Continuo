// 全局监听 commands.* 注册的 hotkey,匹配即执行(M-Plugin v1.6 补漏)。
//
// 'mod' 跨平台:macOS 走 metaKey,其它走 ctrlKey。
// 单 hotkey 字符串 'mod+shift+h' = mod 键 + shift + 'h'。

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useRegistry } from '../registries/useRegistry';
import type { CommandRegistry, CommandSpec } from '../registries/CommandRegistry';
import { useKeybindingsStore } from '../keybindings/keybindings-store';
import { tWithFallback } from '@/i18n';
import { runRegisteredCommand } from '@/lib/run-contributed-action';
import { canonicalHotkeyKey, detectPlatform, type Platform } from './format-hotkey';
import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';
import { baseKeyForShifted, legacyHotkeyKey, physicalHotkeyKey } from './event-hotkey-key';
import { resolveActiveHotkey } from '@/plugins/picker/use-picker-toggle-hotkey';
import { getPopoutDocuments, subscribePopoutDocuments } from '@/shell/dock/popout-documents';
import { hasOpenModalIn } from '@/design/Modal';

/**
 * dockview popout 子窗里也经热键分发的命令:只作用于子窗内的活动面板(dock 的 activePanel 随焦点落在子窗面板上),
 * 不在主窗画东西。mac 上 ⌘W 此前由应用菜单 role:'close' 关掉聚焦的子窗,改为 closeActiveEditor 后须在子窗分发。
 * 保存与下一个 / 上一个编辑器由编辑器面板自己的按键处理覆盖(popout 内同样生效,且只作用于本编辑器 —— 放进这里时
 * 编辑器不在该子窗会切到主窗编辑器、子窗里看不到变化),不在此列。id 与 editor-commands 一致(规范守护)。
 */
export const POPOUT_HOTKEY_COMMAND_IDS: ReadonlySet<string> = new Set([
  'workbench.action.closeActiveEditor',
  // ⇧⌘T:子窗里触发时重开落在该子窗(见 reopen-closed-editor targetOf),不画到主窗
  'workbench.action.reopenClosedEditor',
]);

/** 解析后的修饰键 + 主键签名(平台感知). 解析一次,匹配时纯字段比较. */
interface ComboSignature {
  readonly wantMeta: boolean;
  readonly wantCtrl: boolean;
  readonly wantShift: boolean;
  readonly wantAlt: boolean;
  readonly key: string; // 已 lowercase
}

function isTrimWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

function trimSegmentStart(combo: string, start: number, end: number): number {
  while (start < end && isTrimWhitespace(combo.charCodeAt(start))) start += 1;
  return start;
}

function trimSegmentEnd(combo: string, start: number, end: number): number {
  while (end > start && isTrimWhitespace(combo.charCodeAt(end - 1))) end -= 1;
  return end;
}

function segmentEquals(combo: string, start: number, end: number, token: string): boolean {
  const s = trimSegmentStart(combo, start, end);
  const e = trimSegmentEnd(combo, s, end);
  if (e - s !== token.length) return false;
  for (let i = 0; i < token.length; i += 1) {
    const code = combo.charCodeAt(s + i);
    const lowerCode = code >= 65 && code <= 90 ? code + 32 : code;
    if (lowerCode !== token.charCodeAt(i)) return false;
  }
  return true;
}

function lowerTrimmedSegment(combo: string, start: number, end: number): string {
  const s = trimSegmentStart(combo, start, end);
  const e = trimSegmentEnd(combo, s, end);
  return s < e ? lowerIfNeeded(combo.slice(s, e)) : '';
}

/**
 * 把 'mod+shift+h' 解析成平台感知的修饰键签名(打磨 R26:从每次 keydown 解析
 * 移到配置变化时一次性预编译)。
 *
 * 'mod' = 平台主修饰键(mac=Cmd/metaKey,其它=Ctrl/ctrlKey);'cmd'=metaKey;'ctrl'=ctrlKey。
 * 旧实现把三者塌缩成 `metaKey || ctrlKey` 当 hasMod → mac 上 Ctrl+F/Ctrl+T/Ctrl+B 误匹配
 * mod+f/t/b,把终端/编辑器的 Control 序列被全局命令劫持。分离 meta/ctrl 按平台精确匹配。
 * (复审 loop R15)
 *
 * 未知修饰符(如 'hyper+x')→ 返回 null(不可匹配),不再静默忽略降级成裸 'x' 全局劫持。
 */
function compileCombo(combo: string, platform: Platform): ComboSignature | null {
  const isMac = platform === 'mac';
  let wantMeta = false;
  let wantCtrl = false;
  let wantShift = false;
  let wantAlt = false;
  let start = 0;
  for (;;) {
    const plus = combo.indexOf('+', start);
    if (plus < 0) break;
    if (segmentEquals(combo, start, plus, 'cmd')) {
      wantMeta = true;
    } else if (segmentEquals(combo, start, plus, 'ctrl')) {
      wantCtrl = true;
    } else if (segmentEquals(combo, start, plus, 'mod')) {
      if (isMac) wantMeta = true;
      else wantCtrl = true;
    } else if (segmentEquals(combo, start, plus, 'shift')) {
      wantShift = true;
    } else if (
      segmentEquals(combo, start, plus, 'alt') ||
      segmentEquals(combo, start, plus, 'option')
    ) {
      wantAlt = true;
    } else {
      return null;
    }
    start = plus + 1;
  }
  return {
    wantMeta,
    wantCtrl,
    wantShift,
    wantAlt,
    // 主键别名(up / esc / return …)归一到 e.key 名,与录制、显示同一套词汇;含 shift 时上档符号归一到基础键
    //(旧值 mod+shift+? ≡ 现在录到的 mod+shift+/)。
    key: baseKeyForShifted(canonicalHotkeyKey(lowerTrimmedSegment(combo, start, combo.length)), wantShift),
  };
}

/** 签名是否匹配键盘事件(精确比较四个修饰键 + 主键;主键先按物理键,再按旧 e.key 兜底,见 firstMatchingBinding). */
function signatureMatches(sig: ComboSignature, e: KeyboardEvent): boolean {
  const physical = physicalHotkeyKey(e);
  const legacyKey = legacyHotkeyKey(e, physical);
  return signatureMatchesKey(sig, e, physical ?? legacyKey) || signatureMatchesKey(sig, e, legacyKey);
}

function signatureMatchesKey(sig: ComboSignature, e: KeyboardEvent, keyLower: string): boolean {
  return (
    sig.wantMeta === e.metaKey &&
    sig.wantCtrl === e.ctrlKey &&
    sig.wantShift === e.shiftKey &&
    sig.wantAlt === e.altKey &&
    keyLower === sig.key
  );
}

export function matchesHotkey(
  combo: string,
  e: KeyboardEvent,
  platform: Platform = detectPlatform(),
): boolean {
  const sig = compileCombo(combo, platform);
  return sig !== null && signatureMatches(sig, e);
}

interface CompiledBinding {
  readonly sig: ComboSignature;
  readonly cmd: CommandSpec;
}

const EMPTY_COMPILED_BINDINGS: readonly CompiledBinding[] = [];

/** 事件目标是否在富文本 / 代码编辑器内(Milkdown 的 ProseMirror、CodeMirror 6)。 */
function isInsideCodeEditor(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return typeof el?.closest === 'function' && el.closest('.ProseMirror, .cm-editor') !== null;
}

/** 主键是否功能键 f1–f24(已小写)。 */
function isFunctionKey(key: string): boolean {
  return /^f([1-9]|1\d|2[0-4])$/.test(key);
}

/** 事件目标是否可编辑文本控件(input/textarea/select/contenteditable). */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable === true;
}

/**
 * 预编译分发表。同一按键命中多条时 handler 取表中第一条,故顺序即优先级(对齐 VSCode:用户绑定压过默认):
 * 先放有用户 override 的命令,再放默认绑定的命令;同一层内保持注册顺序。设置页的「冲突」标注
 *(selectShadowedBindings)基于同一张表,两者不会分叉。
 */
export function buildCompiledBindings(
  commands: readonly CommandSpec[],
  platform: Platform,
  overrides: Readonly<Record<string, string>> = {},
): readonly CompiledBinding[] {
  let out: CompiledBinding[] | undefined;
  let count = 0;
  for (let pass = 0; pass < 2; pass++) {
    const userTier = pass === 0;
    for (const cmd of commands) {
      if (Object.hasOwn(overrides, cmd.id) !== userTier) continue; // 只认自有属性(toString 等命令 id)
      // 保留键(⌘P / ⌘⇧P 归 Quick Open / 命令面板)上的绑定(升级前已存的 override / 插件默认 hotkey)视为未绑定:
      // 不入表,否则一键两动作(同 document 监听 stopPropagation 拦不住)。设置页对该行标注未生效。
      const effective = resolveActiveHotkey(cmd, overrides, platform);
      if (!effective) continue; // 无 hotkey、显式 unbind 或落在保留键
      const sig = compileCombo(effective, platform);
      if (!sig) continue; // 未知修饰符 → 不可匹配,不入表
      out ??= new Array<CompiledBinding>(commands.length);
      out[count++] = { sig, cmd };
    }
  }
  if (!out) return EMPTY_COMPILED_BINDINGS;
  out.length = count;
  return out;
}

function signatureKey(sig: ComboSignature): string {
  return `${sig.wantMeta ? 'm' : ''}${sig.wantCtrl ? 'c' : ''}${sig.wantAlt ? 'a' : ''}${sig.wantShift ? 's' : ''}+${sig.key}`;
}

const EMPTY_SHADOWED: ReadonlyMap<string, CommandSpec> = new Map();

/**
 * 冲突落败的命令 id → 实际响应该按键的命令。与分发同一张表(buildCompiledBindings)、同一签名(修饰键 + 主键别名
 * 归一)判定:表中同签名的第一条胜出,其余落败。保留键 / 解绑 / 未知修饰符不入表,不算冲突。
 */
export function selectShadowedBindings(
  commands: readonly CommandSpec[],
  platform: Platform,
  overrides: Readonly<Record<string, string>>,
): ReadonlyMap<string, CommandSpec> {
  const winners = new Map<string, CommandSpec>();
  let shadowed: Map<string, CommandSpec> | null = null;
  for (const b of buildCompiledBindings(commands, platform, overrides)) {
    const key = signatureKey(b.sig);
    const winner = winners.get(key);
    if (winner === undefined) winners.set(key, b.cmd);
    else (shadowed ??= new Map()).set(b.cmd.id, winner);
  }
  return shadowed ?? EMPTY_SHADOWED;
}

// isHotkeyShadowed 的缓存(tooltip / 菜单键位每次渲染都查):命令快照、平台、overrides 引用不变即复用。
let cachedShadowed: {
  readonly commands: readonly CommandSpec[];
  readonly platform: Platform;
  readonly overrides: Readonly<Record<string, string>>;
  readonly shadowed: ReadonlyMap<string, CommandSpec>;
} | null = null;

/**
 * 命令的生效键位是否冲突落败(按下执行的是别的命令,同 selectShadowedBindings / 设置页「冲突」)。界面上的键位提示
 *(命令面板行尾、tooltip、菜单项)据此不显示该键 —— 与保留键上的绑定一样,显示了按下也不会执行这条命令。
 */
export function isHotkeyShadowed(
  commandId: string,
  commands: readonly CommandSpec[],
  platform: Platform,
  overrides: Readonly<Record<string, string>>,
): boolean {
  const c = cachedShadowed;
  let shadowed: ReadonlyMap<string, CommandSpec>;
  if (c && c.commands === commands && c.platform === platform && c.overrides === overrides) shadowed = c.shadowed;
  else {
    shadowed = selectShadowedBindings(commands, platform, overrides);
    cachedShadowed = { commands, platform, overrides, shadowed };
  }
  return shadowed.has(commandId);
}

function firstMatchingBinding(
  bindings: readonly CompiledBinding[],
  e: KeyboardEvent,
): CompiledBinding | undefined {
  // 主键与录制同一规则(event-hotkey-key:⌥ / ⇧ 变形字符按物理键,e.key 小写只算一次)。整表找不到时再按原始 e.key 兜底:旧版按 e.key
  // 录下的 alt+˚ / alt+dead 等仍生效;两轮分开,新写法(alt+u)永远优先于旧兜底(alt+dead)。
  const physical = physicalHotkeyKey(e);
  const legacyKey = legacyHotkeyKey(e, physical);
  const key = physical ?? legacyKey;
  for (const b of bindings) if (signatureMatchesKey(b.sig, e, key)) return b;
  if (key === legacyKey) return undefined;
  for (const b of bindings) if (signatureMatchesKey(b.sig, e, legacyKey)) return b;
  return undefined;
}

// winningCommandFor 的预编译表缓存(面板 / 终端每次按键都要查):命令快照(registry.getAll() 引用稳定)、平台、
// overrides 三者不变即复用。
let cachedTable: {
  readonly commands: readonly CommandSpec[];
  readonly platform: Platform;
  readonly overrides: Readonly<Record<string, string>>;
  readonly bindings: readonly CompiledBinding[];
} | null = null;

function cachedBindings(
  commands: readonly CommandSpec[],
  platform: Platform,
  overrides: Readonly<Record<string, string>>,
): readonly CompiledBinding[] {
  const c = cachedTable;
  if (c && c.commands === commands && c.platform === platform && c.overrides === overrides) return c.bindings;
  const bindings = buildCompiledBindings(commands, platform, overrides);
  cachedTable = { commands, platform, overrides, bindings };
  return bindings;
}

/**
 * 按键在分发表里胜出的命令:与全局分发、设置页「冲突」标注同一张表同一顺序(buildCompiledBindings,表中同签名
 * 第一条)。编辑器面板 / 终端只在胜出命令是自己负责的命令时就地处理 —— 一键一个动作(对齐 VSCode 单表裁决):
 * 用户把别的命令绑到 ⌘S 后,焦点在编辑器 / 终端里 ⌘S 也不再保存。无绑定命中 → undefined。
 */
export function winningCommandFor(
  e: KeyboardEvent,
  commands: readonly CommandSpec[],
  platform: Platform = detectPlatform(),
  overrides: Readonly<Record<string, string>> = useKeybindingsStore.getState().overrides,
): CommandSpec | undefined {
  return firstMatchingBinding(cachedBindings(commands, platform, overrides), e)?.cmd;
}

const augmentedCache = new WeakMap<readonly CommandSpec[], Map<readonly DefaultCommand[], readonly CommandSpec[]>>();

/** 约定的命令 id + 默认键(命令由别的模块注册,尚未注册时兜底)。 */
export type DefaultCommand = Pick<CommandSpec, 'id' | 'hotkey'>;

const NOOP = (): void => {};

/**
 * 命令快照 + 尚未注册的约定命令(按默认键排在默认层末尾)。面板 / 终端裁决时用:注册时序未到(或测试未注册)时
 * 仍按约定默认键处理自己的命令;已注册则以注册的 spec 为准。结果按 (快照, defaults) 缓存,引用稳定。
 */
export function withDefaultCommands(
  registered: readonly CommandSpec[],
  defaults: readonly DefaultCommand[],
): readonly CommandSpec[] {
  let byDefaults = augmentedCache.get(registered);
  const hit = byDefaults?.get(defaults);
  if (hit) return hit;
  let out: CommandSpec[] | null = null;
  for (const d of defaults) {
    if (registered.some((c) => c.id === d.id)) continue;
    (out ??= [...registered]).push({ id: d.id, title: d.id, hotkey: d.hotkey, fn: NOOP });
  }
  const result = out ?? registered;
  if (!byDefaults) augmentedCache.set(registered, (byDefaults = new Map()));
  byDefaults.set(defaults, result);
  return result;
}

/** 事件所在文档有打开的 Modal(对话框期间工作台快捷键不执行,按键留给对话框;对齐 VSCode)。 */
export function isModalOpenFor(e: Event): boolean {
  // 未派发的事件(target 为空)按主窗文档判;target 是 document 本身时 ownerDocument 为 null。
  const target = e.target as Node | null;
  const doc = target?.ownerDocument ?? (target as Document | null) ?? (typeof document === 'undefined' ? null : document);
  return doc !== null && hasOpenModalIn(doc);
}

function createHotkeyHandler(
  bindings: readonly CompiledBinding[],
  commands: CommandRegistry,
  allowedIds?: ReadonlySet<string>,
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    // a11y(A64):事件来自可编辑文本控件(input/textarea/contenteditable/select)时,放行
    // 「无 ctrl/meta/alt 修饰」的绑定(单键如 'x' 或仅 shift 如 'X')—— 否则用户在搜索框/
    // 输入框里键入该字符会被全局命令劫持并 preventDefault,文本打不进去、焦点上下文被破坏。
    // 带 ctrl/meta/alt 的全局组合(如 mod+s 保存)在编辑器内仍需生效,故只跳过无修饰类。
    // 编辑器(ProseMirror / CodeMirror)已用该键执行了自己的动作(preventDefault)→ 不再执行全局命令:否则 Markdown
    // 里 ⌘B 同时加粗与切换侧栏、用户改绑到 mod+d / mod+/ 等编辑器键位时一键两动作(与终端让出 / 编辑器 ⌘S 同族)。
    // 只认编辑器区域:其它可编辑控件(xterm textarea 等)可能对未处理的组合也 preventDefault,不据此拦命令。
    if (e.defaultPrevented && isInsideCodeEditor(e.target)) return;
    // 事件所在文档有打开的 Modal(删除确认 / Agent 授权 / 保存三按钮框、Quick Open…)→ 不执行、不 preventDefault:
    // 否则 ⌘T 在背后新建终端并抢走焦点、⌘W 关掉背后的 tab。Esc / Tab / Enter 交给 Modal 与其中的控件。
    if (isModalOpenFor(e)) return;
    // 在完整表上裁决胜者(与主窗、设置页冲突标注同一张表);限定命令集(popout 子窗)只在胜者属于其中时执行 ——
    // 先滤再匹配会让落败的命令在子窗里复活(用户把别的命令绑到 ⌘W 后,子窗 ⌘W 仍关 tab)。
    const b = firstMatchingBinding(bindings, e);
    if (b && (!allowedIds || allowedIds.has(b.cmd.id))) {
      // 同一事件命中的绑定签名相同(修饰键 + 主键精确比较),A64 放行对它们一致 → 只看第一条。
      // 功能键(F1–F24)不是文字输入键 → 不在放行之列:编辑器 / 输入框里 F6 照常切区域(VSCode 同)。
      if (!isEditableTarget(e.target) || b.sig.wantMeta || b.sig.wantCtrl || b.sig.wantAlt || isFunctionKey(b.sig.key)) {
        e.preventDefault();
        e.stopPropagation();
        // 经 runContributedAction 走:命令(任意插件代码,可 network/fs)同步 throw 或
        // async reject 时弹 error toast,与命令面板 execute 路径(CommandPalette.tsx)
        // 一致。旧实现裸 `void cmd.fn()` → hotkey 触发的失败"按了没反应"完全静默。
        // label 用 localize 后 title 与面板对齐。
        // race(R51):触发时按 id 从 live registry 重查再执行,而非调缓存的 b.cmd.fn()。命令被
        // 插件 disable/reload 同步 unregister 后、到 React 重渲替换本 handler 前的窗口内,旧
        // bindings 闭包仍持已卸载命令的 fn;重查使死命令静默忽略,不再执行已卸载插件代码。
        runRegisteredCommand(commands, b.cmd.id, tWithFallback(b.cmd.titleKey, b.cmd.title));
      }
    }
  };
}

export function useCommandHotkeys(commands: CommandRegistry): void {
  const snap = useRegistry(commands);
  // 用户改键时也要重排监听 — 订阅 keybindings overrides 让预编译表重建
  const overrides = useKeybindingsStore((s) => s.overrides);
  const platform = useMemo(() => detectPlatform(), []);
  const popoutDocs = useSyncExternalStore(subscribePopoutDocuments, getPopoutDocuments);

  // 预编译有效 hotkey 绑定表(打磨 R26):只在命令集 / overrides / 平台变化时重算,
  // 每个 hotkey 解析一次。高频 keydown 路径只做字段比较,不再逐键 split/lowercase/Set
  // + 逐命令读 keybindings store。只保留真有 effective hotkey 的命令。
  const bindings = useMemo<readonly CompiledBinding[]>(() => {
    return buildCompiledBindings(snap, platform, overrides);
  }, [snap, overrides, platform]);
  const hasPopoutBinding = useMemo(
    () => bindings.some((b) => POPOUT_HOTKEY_COMMAND_IDS.has(b.cmd.id)),
    [bindings],
  );

  useEffect(() => {
    if (bindings.length === 0) return;
    const handler = createHotkeyHandler(bindings, commands);
    // 主窗 document 分发全部命令。popout 子窗只分发 POPOUT_HOTKEY_COMMAND_IDS(见下):其它命令效果(新终端、设置面板等)
    // 都画在主窗,从子窗触发时系统焦点留在子窗(renderer 无激活主窗的通路),接着输入的字进了子窗的编辑器 / 终端。
    // 与 ⌘P / ⌘⇧P 同一规则。
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // commands 是稳定 registry 实例(挂载期不变);handler 内 commands.get 做 R51 live 查找。
  }, [bindings, commands]);

  useEffect(() => {
    if (!hasPopoutBinding || popoutDocs.length === 0) return;
    const handler = createHotkeyHandler(bindings, commands, POPOUT_HOTKEY_COMMAND_IDS);
    for (const doc of popoutDocs) doc.addEventListener('keydown', handler);
    // 子窗关闭 → popoutDocs 变化 → 移除旧监听(不泄漏已关子窗的 document)。
    return () => {
      for (const doc of popoutDocs) doc.removeEventListener('keydown', handler);
    };
  }, [bindings, hasPopoutBinding, popoutDocs, commands]);
}
