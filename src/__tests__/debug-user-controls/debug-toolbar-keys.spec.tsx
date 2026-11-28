// @vitest-environment jsdom
// 调试工具栏(状态切换可用性、tooltip 键位)与默认键 when 条件(F5 / F6 / F10 / F11 / ⇧F11 / ⇧F5)。见同目录 README。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({ control: vi.fn(async () => ({ ok: true as const, data: {} })) }));

vi.mock('../../lib/co-api', () => ({
  coApi: {
    debug: {
      onEvent: vi.fn(() => () => undefined),
      subscribe: vi.fn(async () => ({ ok: true, data: { sessions: [] } })),
      getStack: vi.fn(),
      getVariables: vi.fn(),
      control: h.control,
    },
  },
}));

import { debugCommandSpecs, DEBUG_COMMANDS } from '../../panels/Debug/debug-commands';
vi.mock('@/plugins/co-app', async () => {
  const specs = (await import('../../panels/Debug/debug-commands')).debugCommandSpecs();
  return {
    coApp: {
      editor: { openFile: vi.fn() },
      commands: {
        getAll: () => specs,
        get: (id: string) => specs.find((s) => s.id === id),
        subscribe: () => () => undefined,
      },
    },
  };
});

import { DebugPanel } from '../../panels/Debug/DebugPanel';
import { resetDebugStoreForTest, useDebugStore, type DebugSessionShadow } from '../../stores/debug.store';
import { winningCommandFor } from '../../plugins/command-palette/useCommandHotkeys';
import { FOCUS_NEXT_PART_COMMAND } from '../../shell/focus-parts';
import { setLocale } from '../../i18n';
import type { CommandSpec } from '../../plugins/registries/CommandRegistry';

function session(stopped: boolean): DebugSessionShadow {
  return {
    id: 's1',
    label: 'app.js',
    breakpoints: [],
    frames: [],
    scopes: [],
    variableRefs: new Map(),
    lastStoppedOrder: stopped ? 1 : 0,
    ...(stopped ? { stopped: { reason: 'breakpoint', stopSeq: 1 } } : {}),
  };
}

function seed(state: 'inactive' | 'running' | 'stopped'): void {
  useDebugStore.setState({
    sessions: state === 'inactive' ? new Map() : new Map([['s1', session(state === 'stopped')]]),
    activeSessionId: state === 'stopped' ? 's1' : null,
  });
}

const button = (name: RegExp) => screen.getByRole('button', { name });
const isDisabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled;

afterEach(() => {
  cleanup();
  resetDebugStoreForTest();
  vi.clearAllMocks();
  setLocale('en');
});

describe('调试工具栏', () => {
  it('已停住:继续 / 单步 / 停止可用,没有暂停;tooltip「名称 (键位)」;点击对显示的会话发动作', () => {
    setLocale('en');
    seed('stopped');
    render(<DebugPanel />);
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    for (const name of ['Continue', 'Step Over', 'Step Into', 'Step Out', 'Stop']) {
      expect(isDisabled(button(new RegExp(`^${name}$`)))).toBe(false);
    }
    expect(button(/^Continue$/).getAttribute('title')).toEqual('Continue (F5)');
    expect(button(/^Step Out$/).getAttribute('title')).toEqual(expect.stringMatching(/^Step Out \((⇧F11|Shift\+F11)\)$/));
    fireEvent.click(button(/^Step Over$/));
    expect(h.control).toHaveBeenCalledWith({ sessionId: 's1', action: 'stepOver' });
  });

  it('运行中:继续换成暂停;单步不可用,停止可用', () => {
    seed('running');
    render(<DebugPanel />);
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(isDisabled(button(/^Pause$/))).toBe(false);
    expect(button(/^Pause$/).getAttribute('title')).toEqual('Pause (F6)');
    expect(isDisabled(button(/^Step Over$/))).toBe(true);
    expect(isDisabled(button(/^Step Into$/))).toBe(true);
    expect(isDisabled(button(/^Stop$/))).toBe(false);
    fireEvent.click(button(/^Pause$/));
    expect(h.control).toHaveBeenCalledWith({ sessionId: 's1', action: 'pause' });
  });

  it('三语:按钮名称 / 命令标题本地化', () => {
    setLocale('zh');
    seed('stopped');
    render(<DebugPanel />);
    for (const name of ['继续', '单步跳过', '单步调试', '单步跳出', '停止']) expect(isDisabled(button(new RegExp(`^${name}$`)))).toBe(false);
    cleanup();
    setLocale('ko');
    render(<DebugPanel />);
    for (const name of ['계속', '단위 실행', '단계 정보', '단계 출력', '중지']) expect(isDisabled(button(new RegExp(`^${name}$`)))).toBe(false);
  });
});

describe('命令与默认键(VSCode debugCommands)', () => {
  const all = (): CommandSpec[] => [...debugCommandSpecs(), { ...FOCUS_NEXT_PART_COMMAND, title: 'Focus Next Part', fn: () => undefined }];
  const press = (key: string, shiftKey = false) =>
    new KeyboardEvent('keydown', { key, code: key, shiftKey, bubbles: true });

  it('VSCode 同名命令 id 与默认键,分类「调试」', () => {
    expect(debugCommandSpecs().map((s) => [s.id, s.hotkey, s.when, s.categoryKey])).toEqual([
      ['workbench.action.debug.continue', 'f5', 'debugStopped', 'commands.debug.category'],
      ['workbench.action.debug.pause', 'f6', 'debugRunning', 'commands.debug.category'],
      ['workbench.action.debug.stepOver', 'f10', 'debugStopped', 'commands.debug.category'],
      ['workbench.action.debug.stepInto', 'f11', 'inDebugMode', 'commands.debug.category'],
      ['workbench.action.debug.stepOut', 'shift+f11', 'debugStopped', 'commands.debug.category'],
      ['workbench.action.debug.stop', 'shift+f5', 'inDebugMode', 'commands.debug.category'],
    ]);
  });

  it.each(['mac', 'other'] as const)('%s(mac / Windows·Linux):按会话状态分发;不成立时让给后面的同键绑定', (platform) => {
    const winner = (key: string, shift = false) => winningCommandFor(press(key, shift), all(), platform, {})?.id;
    seed('inactive');
    expect(winner('F5')).toBeUndefined();
    expect(winner('F10')).toBeUndefined();
    expect(winner('F5', true)).toBeUndefined();
    expect(winner('F6')).toBe(FOCUS_NEXT_PART_COMMAND.id);

    seed('running');
    expect(winner('F5')).toBeUndefined();
    expect(winner('F6')).toBe('workbench.action.debug.pause');
    expect(winner('F10')).toBeUndefined();
    expect(winner('F11')).toBe('workbench.action.debug.stepInto');
    expect(winner('F5', true)).toBe('workbench.action.debug.stop');

    seed('stopped');
    expect(winner('F5')).toBe('workbench.action.debug.continue');
    expect(winner('F6')).toBe(FOCUS_NEXT_PART_COMMAND.id);
    expect(winner('F10')).toBe('workbench.action.debug.stepOver');
    expect(winner('F11', true)).toBe('workbench.action.debug.stepOut');
  });

  it('命令面板执行(不受 when 限制)按会话状态判定:运行中「继续」无操作,停住时发出', async () => {
    const run = (id: string) => debugCommandSpecs().find((s) => s.id === id)!.fn();
    seed('running');
    await run('workbench.action.debug.continue');
    expect(h.control).not.toHaveBeenCalled();
    seed('stopped');
    await run('workbench.action.debug.continue');
    expect(h.control).toHaveBeenCalledWith({ sessionId: 's1', action: 'continue' });
    expect(DEBUG_COMMANDS.find((c) => c.action === 'stop')!.enabledIn).toEqual(['running', 'stopped']);
  });
});
