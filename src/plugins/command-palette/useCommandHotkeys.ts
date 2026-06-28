// 全局监听 commands.* 注册的 hotkey,匹配即执行(M-Plugin v1.6 补漏)。
//
// 'mod' 跨平台:macOS 走 metaKey,其它走 ctrlKey。
// 单 hotkey 字符串 'mod+shift+h' = mod 键 + shift + 'h'。

import { useEffect, useMemo } from 'react';
import { useRegistry } from '../registries/useRegistry';
import type { CommandRegistry, CommandSpec } from '../registries/CommandRegistry';
import { useKeybindingsStore } from '../keybindings/keybindings-store';
import { tWithFallback } from '@/i18n';
import { runContributedAction } from '@/lib/run-contributed-action';
import { detectPlatform, type Platform } from './format-hotkey';

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

function lowerIfNeeded(value: string): string {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code >= 65 && code <= 90) || code > 127) {
      return value.toLowerCase();
    }
  }
  return value;
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
 * (codex 复审 loop R15)
 */
function compileCombo(combo: string, platform: Platform): ComboSignature {
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
    }
    start = plus + 1;
  }
  return {
    wantMeta,
    wantCtrl,
    wantShift,
    wantAlt,
    key: lowerTrimmedSegment(combo, start, combo.length),
  };
}

/** 签名是否匹配键盘事件(精确比较四个修饰键 + 主键). */
function signatureMatches(sig: ComboSignature, e: KeyboardEvent): boolean {
  return signatureMatchesKey(sig, e, lowerIfNeeded(e.key));
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
  return signatureMatches(compileCombo(combo, platform), e);
}

interface CompiledBinding {
  readonly sig: ComboSignature;
  readonly cmd: CommandSpec;
}

const EMPTY_COMPILED_BINDINGS: readonly CompiledBinding[] = [];

/** 事件目标是否可编辑文本控件(input/textarea/select/contenteditable). */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable === true;
}

export function buildCompiledBindings(
  commands: readonly CommandSpec[],
  platform: Platform,
  overrides: Readonly<Record<string, string>> = {},
): readonly CompiledBinding[] {
  let out: CompiledBinding[] | undefined;
  let count = 0;
  for (const cmd of commands) {
    const override = overrides[cmd.id];
    if (!cmd.hotkey && override === undefined) continue;
    const effective =
      override !== undefined ? (override === '' ? undefined : override) : cmd.hotkey;
    if (!effective) continue; // 无 hotkey 或显式 unbind
    out ??= new Array<CompiledBinding>(commands.length);
    out[count++] = { sig: compileCombo(effective, platform), cmd };
  }
  if (!out) return EMPTY_COMPILED_BINDINGS;
  out.length = count;
  return out;
}

export function useCommandHotkeys(commands: CommandRegistry): void {
  const snap = useRegistry(commands);
  // 用户改键时也要重排监听 — 订阅 keybindings overrides 让预编译表重建
  const overrides = useKeybindingsStore((s) => s.overrides);
  const platform = useMemo(() => detectPlatform(), []);

  // 预编译有效 hotkey 绑定表(打磨 R26):只在命令集 / overrides / 平台变化时重算,
  // 每个 hotkey 解析一次。高频 keydown 路径只做字段比较,不再逐键 split/lowercase/Set
  // + 逐命令读 keybindings store。只保留真有 effective hotkey 的命令。
  const bindings = useMemo<readonly CompiledBinding[]>(() => {
    return buildCompiledBindings(snap, platform, overrides);
  }, [snap, overrides, platform]);

  useEffect(() => {
    if (bindings.length === 0) return;

    const handler = (e: KeyboardEvent) => {
      // a11y(A64):事件来自可编辑文本控件(input/textarea/contenteditable/select)时,放行
      // 「无 ctrl/meta/alt 修饰」的绑定(单键如 'x' 或仅 shift 如 'X')—— 否则用户在搜索框/
      // 输入框里键入该字符会被全局命令劫持并 preventDefault,文本打不进去、焦点上下文被破坏。
      // 带 ctrl/meta/alt 的全局组合(如 mod+s 保存)在编辑器内仍需生效,故只跳过无修饰类。
      const editable = isEditableTarget(e.target);
      const keyLower = lowerIfNeeded(e.key);
      for (const b of bindings) {
        if (signatureMatchesKey(b.sig, e, keyLower)) {
          if (editable && !b.sig.wantMeta && !b.sig.wantCtrl && !b.sig.wantAlt) {
            continue;
          }
          e.preventDefault();
          e.stopPropagation();
          // 经 runContributedAction 走:命令(任意插件代码,可 network/fs)同步 throw 或
          // async reject 时弹 error toast,与命令面板 execute 路径(CommandPalette.tsx)
          // 一致。旧实现裸 `void cmd.fn()` → hotkey 触发的失败"按了没反应"完全静默。
          // label 用 localize 后 title 与面板对齐。
          // race(R51):触发时按 id 从 live registry 重查再执行,而非调缓存的 b.cmd.fn()。命令被
          // 插件 disable/reload 同步 unregister 后、到 React 重渲替换本 handler 前的窗口内,旧
          // bindings 闭包仍持已卸载命令的 fn;重查使死命令静默忽略,不再执行已卸载插件代码。
          runContributedAction(tWithFallback(b.cmd.titleKey, b.cmd.title), () => {
            const live = commands.get(b.cmd.id);
            if (!live) return;
            return live.fn();
          });
          return;
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // commands 是稳定 registry 实例(挂载期不变);handler 内 commands.get 做 R51 live 查找。
  }, [bindings, commands]);
}
