// @vitest-environment jsdom
// topic 49 第十二 session · codex 复审 loop R15:全局命令热键的 'mod' 必须平台感知,不能在 macOS 把 Ctrl 当 Cmd。
//
// 根因:matchesHotkey 注释一直写「mod macOS 走 metaKey,其它走 ctrlKey」,但实装把
// mod/cmd/ctrl 塌缩成 `wantMod` + `hasMod = metaKey || ctrlKey`。macOS 上 Ctrl+F/Ctrl+T/
// Ctrl+B 因 ctrlKey=true 误匹配 mod+f/t/b → 全局命令 preventDefault+stopPropagation 抢走,
// xterm/编辑器收不到原始 Control 序列(终端 readline/control key 被劫持)。显示侧 format-hotkey
// 已平台感知(mac 显示 ⌘),匹配侧没有 = 不一致 + 注释↔实装矛盾 = 真 bug。
//
// 修:matchesHotkey 接 platform(默认 detectPlatform());mod 在 mac 只匹配 metaKey、其它只
// 匹配 ctrlKey;cmd 只 metaKey;ctrl 只 ctrlKey。

import { describe, it, expect } from 'vitest';
import { matchesHotkey } from '../../plugins/command-palette/useCommandHotkeys';

function ev(opts: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: opts.key,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
  });
}

describe('topic49 codex-loop R15 · mod 平台感知(mac Ctrl≠Cmd)', () => {
  it('macOS:Ctrl+F 不匹配 mod+f(不劫持终端 Control 序列)', () => {
    expect(matchesHotkey('mod+f', ev({ key: 'f', ctrlKey: true }), 'mac')).toBe(false);
  });

  it('macOS:Cmd+F(metaKey)才匹配 mod+f', () => {
    expect(matchesHotkey('mod+f', ev({ key: 'f', metaKey: true }), 'mac')).toBe(true);
  });

  it('macOS:Ctrl+F 匹配显式 ctrl+f', () => {
    expect(matchesHotkey('ctrl+f', ev({ key: 'f', ctrlKey: true }), 'mac')).toBe(true);
  });

  it('macOS:Cmd+F 不匹配 ctrl+f', () => {
    expect(matchesHotkey('ctrl+f', ev({ key: 'f', metaKey: true }), 'mac')).toBe(false);
  });

  it('其它平台:Ctrl+F 仍匹配 mod+f', () => {
    expect(matchesHotkey('mod+f', ev({ key: 'f', ctrlKey: true }), 'other')).toBe(true);
  });

  it('其它平台:Meta+F 不匹配 mod+f', () => {
    expect(matchesHotkey('mod+f', ev({ key: 'f', metaKey: true }), 'other')).toBe(false);
  });

  it('cmd 跨平台只匹配 metaKey', () => {
    expect(matchesHotkey('cmd+k', ev({ key: 'k', metaKey: true }), 'other')).toBe(true);
    expect(matchesHotkey('cmd+k', ev({ key: 'k', ctrlKey: true }), 'other')).toBe(false);
  });
});
