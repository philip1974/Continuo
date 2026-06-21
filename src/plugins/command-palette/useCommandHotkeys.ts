// 全局监听 commands.* 注册的 hotkey,匹配即执行(M-Plugin v1.6 补漏)。
//
// 'mod' 跨平台:macOS 走 metaKey,其它走 ctrlKey。
// 单 hotkey 字符串 'mod+shift+h' = mod 键 + shift + 'h'。

import { useEffect, useMemo } from 'react';
import { useRegistry } from '../registries/useRegistry';
import type { CommandRegistry, CommandSpec } from '../registries/CommandRegistry';
import {
  getEffectiveHotkey,
  useKeybindingsStore,
} from '../keybindings/keybindings-store';
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
  const parts = combo.toLowerCase().split('+').map((s) => s.trim());
  const key = parts[parts.length - 1]!;
  const mods = new Set(parts.slice(0, -1));
  const isMac = platform === 'mac';
  return {
    wantMeta: mods.has('cmd') || (mods.has('mod') && isMac),
    wantCtrl: mods.has('ctrl') || (mods.has('mod') && !isMac),
    wantShift: mods.has('shift'),
    wantAlt: mods.has('alt') || mods.has('option'),
    key,
  };
}

/** 签名是否匹配键盘事件(精确比较四个修饰键 + 主键). */
function signatureMatches(sig: ComboSignature, e: KeyboardEvent): boolean {
  return (
    sig.wantMeta === e.metaKey &&
    sig.wantCtrl === e.ctrlKey &&
    sig.wantShift === e.shiftKey &&
    sig.wantAlt === e.altKey &&
    e.key.toLowerCase() === sig.key
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

export function useCommandHotkeys(commands: CommandRegistry): void {
  const snap = useRegistry(commands);
  // 用户改键时也要重排监听 — 订阅 keybindings overrides 让预编译表重建
  const overrides = useKeybindingsStore((s) => s.overrides);
  const platform = useMemo(() => detectPlatform(), []);

  // 预编译有效 hotkey 绑定表(打磨 R26):只在命令集 / overrides / 平台变化时重算,
  // 每个 hotkey 解析一次。高频 keydown 路径只做字段比较,不再逐键 split/lowercase/Set
  // + 逐命令读 keybindings store。只保留真有 effective hotkey 的命令。
  const bindings = useMemo<readonly CompiledBinding[]>(() => {
    const out: CompiledBinding[] = [];
    for (const cmd of snap) {
      const effective = getEffectiveHotkey(cmd);
      if (!effective) continue; // 无 hotkey 或显式 unbind
      out.push({ sig: compileCombo(effective, platform), cmd });
    }
    return out;
    // overrides 不直接被 body 引用,但它变化时 getEffectiveHotkey 结果变 → 必须重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, overrides, platform]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      for (const b of bindings) {
        if (signatureMatches(b.sig, e)) {
          e.preventDefault();
          e.stopPropagation();
          // 经 runContributedAction 走:命令(任意插件代码,可 network/fs)同步 throw 或
          // async reject 时弹 error toast,与命令面板 execute 路径(CommandPalette.tsx)
          // 一致。旧实现裸 `void cmd.fn()` → hotkey 触发的失败"按了没反应"完全静默。
          // label 用 localize 后 title 与面板对齐。
          runContributedAction(tWithFallback(b.cmd.titleKey, b.cmd.title), () =>
            b.cmd.fn(),
          );
          return;
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [bindings]);
}
