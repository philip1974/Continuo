// 全局监听 commands.* 注册的 hotkey,匹配即执行(M-Plugin v1.6 补漏)。
//
// 'mod' 跨平台:macOS 走 metaKey,其它走 ctrlKey。
// 单 hotkey 字符串 'mod+shift+h' = mod 键 + shift + 'h'。

import { useEffect } from 'react';
import { useRegistry } from '../registries/useRegistry';
import type { CommandRegistry } from '../registries/CommandRegistry';
import {
  getEffectiveHotkey,
  useKeybindingsStore,
} from '../keybindings/keybindings-store';
import { tWithFallback } from '@/i18n';
import { runContributedAction } from '@/lib/run-contributed-action';
import { detectPlatform, type Platform } from './format-hotkey';

export function matchesHotkey(
  combo: string,
  e: KeyboardEvent,
  platform: Platform = detectPlatform(),
): boolean {
  const parts = combo.toLowerCase().split('+').map((s) => s.trim());
  if (parts.length === 0) return false;
  const key = parts[parts.length - 1]!;
  const mods = new Set(parts.slice(0, -1));

  // 'mod' = 平台主修饰键(mac=Cmd/metaKey,其它=Ctrl/ctrlKey);'cmd'=metaKey;'ctrl'=ctrlKey。
  // 旧实现把三者塌缩成 `metaKey || ctrlKey` 当 hasMod → mac 上 Ctrl+F/Ctrl+T/Ctrl+B 误匹配
  // mod+f/t/b,把终端/编辑器的 Control 序列被全局命令劫持(注释一直写「mod macOS 走 metaKey」,
  // 实装没做,显示侧 format-hotkey 却已平台感知 = 不一致)。分离 meta/ctrl 按平台精确匹配。
  // (codex 复审 loop R15)
  const isMac = platform === 'mac';
  const wantMeta = mods.has('cmd') || (mods.has('mod') && isMac);
  const wantCtrl = mods.has('ctrl') || (mods.has('mod') && !isMac);
  const wantShift = mods.has('shift');
  const wantAlt = mods.has('alt') || mods.has('option');

  if (wantMeta !== e.metaKey) return false;
  if (wantCtrl !== e.ctrlKey) return false;
  if (wantShift !== e.shiftKey) return false;
  if (wantAlt !== e.altKey) return false;
  return e.key.toLowerCase() === key;
}

export function useCommandHotkeys(commands: CommandRegistry): void {
  const snap = useRegistry(commands);
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
          // 经 runContributedAction 走:命令(任意插件代码,可 network/fs)同步 throw 或
          // async reject 时弹 error toast,与命令面板 execute 路径(CommandPalette.tsx)
          // 一致。旧实现裸 `void cmd.fn()` → hotkey 触发的失败"按了没反应"完全静默
          // (helper 建了未传播到此平行调用点)。label 用 localize 后 title 与面板对齐。
          runContributedAction(tWithFallback(cmd.titleKey, cmd.title), () =>
            cmd.fn(),
          );
          return;
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [snap, overrides]);
}
