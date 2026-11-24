// @vitest-environment jsdom
// 录键弹窗提示行的键帽按平台显示(formatHotkeyParts),与同框录到的组合同一套符号:mac 上是 ↵ / ⌫ / ⎋,
// 不再写死 Enter / Backspace / Esc(同框录到 ⌘↵ 时两种写法并存)。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('../../plugins/command-palette/format-hotkey', async (importActual) => {
  const actual = await importActual<typeof import('../../plugins/command-palette/format-hotkey')>();
  return { ...actual, detectPlatform: () => 'mac' as const };
});

import { KeybindingCaptureModal } from '../../plugins/keybindings/KeybindingCaptureModal';

afterEach(() => cleanup());

describe('KeybindingCaptureModal — 提示行键帽按平台', () => {
  it('mac:↵ 保存 / ⌫ 清空 / ⎋ 取消,默认键 ⌘K', () => {
    render(
      <KeybindingCaptureModal
        visible
        commandId="cmd.a"
        commandTitle="Command A"
        currentHotkey={undefined}
        defaultHotkey="mod+k"
        allCommands={[]}
        overrides={{}}
        onSave={vi.fn()}
        onClose={vi.fn()}
        onResetToDefault={vi.fn()}
      />,
    );
    const hints = document.querySelector('[data-testid="keybinding-capture-hints"]')!;
    const caps = Array.from(hints.querySelectorAll('kbd')).map((k) => k.textContent);
    expect(caps).toEqual(['↵', '⌫', '⎋']);
    expect(hints.textContent).not.toMatch(/Enter|Backspace|Esc/);
    expect(hints.textContent).toContain('⌘K');
  });
});
