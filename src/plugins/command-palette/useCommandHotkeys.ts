// 全局监听 commands.* 注册的 hotkey,匹配即执行(M-Plugin v1.6 补漏)。
//
// 'mod' 跨平台:macOS 走 metaKey,其它走 ctrlKey。
// 单 hotkey 字符串 'mod+shift+h' = mod 键 + shift + 'h'。

import { useEffect, useState } from 'react';
import type { CommandRegistry, CommandSpec } from '../registries/CommandRegistry';
import {
  getEffectiveHotkey,
  useKeybindingsStore,
} from '../keybindings/keybindings-store';

export function matchesHotkey(combo: string, e: KeyboardEvent): boolean {
  const parts = combo.toLowerCase().split('+').map((s) => s.trim());
  if (parts.length === 0) return false;
  const key = parts[parts.length - 1]!;
  const mods = new Set(parts.slice(0, -1));

  const wantMod = mods.has('mod') || mods.has('cmd') || mods.has('ctrl');
  const wantShift = mods.has('shift');
  const wantAlt = mods.has('alt') || mods.has('option');

  const hasMod = e.metaKey || e.ctrlKey;
  if (wantMod !== hasMod) return false;
  if (wantShift !== e.shiftKey) return false;
  if (wantAlt !== e.altKey) return false;
  return e.key.toLowerCase() === key;
}

export function useCommandHotkeys(commands: CommandRegistry): void {
  const [snap, setSnap] = useState<readonly CommandSpec[]>(() =>
    commands.getAll(),
  );
  useEffect(
    () => commands.subscribe(() => setSnap(commands.getAll())),
    [commands],
  );
  // 用户改键时也要重排监听 — 订阅 keybindings overrides 让 effect 重跑
  const overrides = useKeybindingsStore((s) => s.overrides);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      for (const cmd of snap) {
        const effective = getEffectiveHotkey(cmd);
        if (!effective) continue; // 无 hotkey 或显式 unbind
        if (matchesHotkey(effective, e)) {
          e.preventDefault();
          e.stopPropagation();
          void cmd.fn();
          return;
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [snap, overrides]);
}
