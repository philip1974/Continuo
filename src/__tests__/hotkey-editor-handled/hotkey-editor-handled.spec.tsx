// @vitest-environment jsdom
// 编辑器(ProseMirror / CodeMirror)已用某键执行了自己的动作(preventDefault)时,全局命令热键不再执行同一按键:
// 否则 Markdown 里 ⌘B 同时加粗与切换侧栏(Milkdown strong 绑 Mod-b 只 preventDefault 不阻止冒泡)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useCommandHotkeys } from '../../plugins/command-palette/useCommandHotkeys';
import { detectPlatform } from '../../plugins/command-palette/format-hotkey';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';

const mod = (): KeyboardEventInit =>
  detectPlatform() === 'mac' ? { metaKey: true } : { ctrlKey: true };

function host(className: string): HTMLElement {
  const outer = document.createElement('div');
  outer.className = className;
  const inner = document.createElement('div');
  inner.setAttribute('contenteditable', 'true');
  outer.appendChild(inner);
  document.body.appendChild(outer);
  return inner;
}

function press(target: Element, handled: boolean): void {
  const ev = new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true, ...mod() });
  if (handled) target.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
  target.dispatchEvent(ev);
}

let fn: ReturnType<typeof vi.fn>;
beforeEach(() => {
  useKeybindingsStore.setState({ overrides: {} });
  fn = vi.fn();
  const reg = new CommandRegistry();
  reg.register({ id: 'toggle', title: 'T', hotkey: 'mod+b', fn });
  renderHook(() => useCommandHotkeys(reg));
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('全局命令热键 · 编辑器已处理的按键', () => {
  it('ProseMirror 内已 preventDefault → 不执行命令', () => {
    press(host('ProseMirror'), true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('CodeMirror 内已 preventDefault → 不执行命令', () => {
    press(host('cm-editor'), true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('编辑器内未处理 → 照常执行(带修饰键的全局命令在编辑器里仍生效)', () => {
    press(host('ProseMirror'), false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('编辑器之外的可编辑控件即使 preventDefault 也照常执行(如 xterm textarea)', () => {
    press(host('xterm'), true);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
