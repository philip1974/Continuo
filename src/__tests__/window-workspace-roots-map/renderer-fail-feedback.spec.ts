// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import TerminalPlugin from '@/core-plugins/TerminalPlugin';
import { HeaderActions } from '@/shell/dock/HeaderActions';

const mocks = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  getWorkspaceState: vi.fn(() => ({ root: null })),
  panels: [
    {
      type: 'terminal',
      title: 'Terminal',
      factory: vi.fn(),
    },
  ],
  notify: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    system: { windowId: 1 },
    terminal: {
      create: mocks.createTerminal,
    },
  },
}));

vi.mock('@/notifications/notify', () => ({
  notify: Object.assign(
    (...args: unknown[]) => mocks.notify.error(...args),
    {
      error: mocks.notify.error,
      warn: mocks.notify.warn,
      info: mocks.notify.info,
      success: mocks.notify.success,
    },
  ),
}));

vi.mock('@/stores/workspace.store', () => ({
  useWorkspaceStore: Object.assign(vi.fn(), {
    getState: mocks.getWorkspaceState,
  }),
}));

vi.mock('@/shell/dock/DockReconciler', () => ({
  setPendingFocus: vi.fn(),
}));

vi.mock('@/plugins/co-app', () => ({
  coApp: {
    panels: {
      getAll: vi.fn(() => mocks.panels),
      subscribe: vi.fn(() => () => undefined),
    },
  },
}));

vi.mock('@/lib/popout-mode', () => ({
  isPopoutWindow: vi.fn(() => false),
  popoutUrlFor: vi.fn((url: string) => url),
}));

vi.mock('@/design', async () => {
  const ReactMod = await import('react');
  return {
    IconButton: ReactMod.forwardRef<
      HTMLButtonElement,
      React.ButtonHTMLAttributes<HTMLButtonElement> & {
        children: React.ReactNode;
      }
    >(function IconButton({ children, ...props }, ref) {
      return ReactMod.createElement(
        'button',
        { ...props, ref, type: 'button' },
        children,
      );
    }),
    MenuItem: ({
      children,
      onClick,
      title,
    }: {
      children: React.ReactNode;
      onClick: () => void;
      title?: string;
    }) =>
      ReactMod.createElement(
        'button',
        { type: 'button', role: 'menuitem', title, onClick },
        children,
      ),
  };
});

function collectTerminalCommands(): CommandSpec[] {
  const commands: CommandSpec[] = [];
  const app = {
    panels: {
      register: vi.fn(() => ({ dispose: vi.fn() })),
    },
    commands: {
      register: vi.fn((spec: CommandSpec) => {
        commands.push(spec);
        return { dispose: vi.fn() };
      }),
    },
  };
  const plugin = new TerminalPlugin(app as never, {
    id: 'core.terminal',
    name: 'Terminal',
    version: '1.0.0',
  });
  plugin.onload();
  return commands;
}

function terminalCommand(): CommandSpec {
  const cmd = collectTerminalCommands().find((c) => c.id === 'terminal.new');
  if (!cmd) throw new Error('missing terminal.new command');
  return cmd;
}

function renderHeaderActions() {
  return render(
    React.createElement(HeaderActions, {
      containerApi: {
        addPanel: vi.fn(),
        addPopoutGroup: vi.fn(),
      },
      group: {},
      activePanel: null,
    } as never),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.createTerminal.mockReset();
  mocks.getWorkspaceState.mockReset();
  mocks.getWorkspaceState.mockReturnValue({ root: null });
  mocks.notify.error.mockReset();
  mocks.notify.warn.mockReset();
  mocks.notify.info.mockReset();
  mocks.notify.success.mockReset();
});

describe('window-workspace-roots-map: renderer terminal create failure feedback', () => {
  it('T19: TerminalPlugin Cmd+T shows workspace guidance for unresolved cwd', async () => {
    mocks.createTerminal.mockResolvedValue({
      ok: false,
      code: 'TERMINAL_CWD_UNRESOLVED',
    });

    await terminalCommand().fn();

    expect(mocks.notify.error).toHaveBeenCalledOnce();
    expect(mocks.notify.error.mock.calls[0]?.[0]).toContain('请先打开 workspace');
  });

  it('T20: TerminalPlugin Cmd+T shows generic terminal create error code', async () => {
    mocks.createTerminal.mockResolvedValue({
      ok: false,
      code: 'OTHER_ERROR',
    });

    await terminalCommand().fn();

    // topic-19: setup 默认 locale=zh → t('errors.terminal.create_failed', {code}) = '无法新建终端：{code}'
    expect(mocks.notify.error).toHaveBeenCalledWith(
      expect.stringContaining('OTHER_ERROR'),
      expect.objectContaining({ code: 'OTHER_ERROR' }),
    );
  });

  it('T21: HeaderActions terminal menu shows workspace guidance for unresolved cwd', async () => {
    mocks.createTerminal.mockResolvedValue({
      ok: false,
      code: 'TERMINAL_CWD_UNRESOLVED',
    });
    const { getByRole } = renderHeaderActions();

    fireEvent.click(getByRole('button', { name: 'More actions' }));
    const terminalItem = await waitFor(() =>
      getByRole('menuitem', { name: 'Terminal' }),
    );
    fireEvent.click(terminalItem);

    await waitFor(() => {
      expect(mocks.notify.error).toHaveBeenCalledOnce();
    });
    expect(mocks.notify.error.mock.calls[0]?.[0]).toContain('请先打开 workspace');
  });
});
