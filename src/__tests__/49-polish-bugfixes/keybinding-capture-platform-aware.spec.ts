// @vitest-environment jsdom
// topic 49 第十二 session · codex 复审 loop R16:KeybindingCaptureModal 捕获快捷键时 'mod'/'ctrl' 必须平台感知。
//
// 根因:R15 让 matchesHotkey 平台感知(mac 上 mod 只匹配 metaKey、ctrl 只匹配 ctrlKey),但捕获
// 侧 eventToCombo 仍 `if (e.metaKey || e.ctrlKey) parts.push('mod')` 塌缩 → mac 用户按 Ctrl+K
// 被存成 mod+k,而 mod+k 按 R15 只匹配 Cmd+K → 用户自定义的 Ctrl 绑定失效,冲突检测也拿错组合
// 比对。捕获侧没传播 R15 的平台感知(R15 兄弟缺口)。
//
// 修:eventToCombo 平台感知 —— mac:metaKey→mod、ctrlKey→ctrl;非 mac:ctrlKey→mod、metaKey→cmd。

import { describe, it, expect } from 'vitest';
import { eventToCombo } from '../../plugins/keybindings/KeybindingCaptureModal';

function ev(opts: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: opts.key,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
  });
}

describe('topic49 codex-loop R16 · eventToCombo 平台感知', () => {
  it('macOS:Ctrl+K 存成 ctrl+k(不是 mod+k)', () => {
    expect(eventToCombo(ev({ key: 'k', ctrlKey: true }), 'mac')).toBe('ctrl+k');
  });

  it('macOS:Cmd+K(metaKey)存成 mod+k', () => {
    expect(eventToCombo(ev({ key: 'k', metaKey: true }), 'mac')).toBe('mod+k');
  });

  it('其它平台:Ctrl+K 存成 mod+k', () => {
    expect(eventToCombo(ev({ key: 'k', ctrlKey: true }), 'other')).toBe('mod+k');
  });

  it('其它平台:Meta+K 存成 cmd+k', () => {
    expect(eventToCombo(ev({ key: 'k', metaKey: true }), 'other')).toBe('cmd+k');
  });

  it('修饰键组合保序:mac Cmd+Shift+X → mod+shift+x', () => {
    expect(eventToCombo(ev({ key: 'x', metaKey: true, shiftKey: true }), 'mac')).toBe(
      'mod+shift+x',
    );
  });

  it('单独修饰键 → null(等用户继续按)', () => {
    expect(eventToCombo(ev({ key: 'Control', ctrlKey: true }), 'mac')).toBeNull();
    expect(eventToCombo(ev({ key: 'Meta', metaKey: true }), 'mac')).toBeNull();
  });
});
