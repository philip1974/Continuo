// @vitest-environment jsdom
import React, { useEffect } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationsProvider, useNotify } from '@/notifications/NotificationsProvider';
import { useTerminalStore, type TerminalSession } from '@/stores/terminal.store';
import { useTerminalDragDrop } from '@/panels/Terminal/useTerminalDragDrop';

const mocks = vi.hoisted(() => ({
  getPathForFile: vi.fn<(file: File) => string>(),
  write: vi.fn<(id: string, data: string) => Promise<{ ok: true } | { ok: false; code: string; message?: string }>>(),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    window: {
      getPathForFile: mocks.getPathForFile,
    },
    terminal: {
      write: mocks.write,
    },
  },
}));

vi.mock('@/i18n', () => ({
  useT: () => (key: string, params?: { count?: number }) =>
    params?.count === undefined ? key : `${key}:${params.count}`,
}));

type Handlers = ReturnType<typeof useTerminalDragDrop>;

let handlers: Handlers | null = null;
let notifications: readonly string[] = [];

function Probe() {
  const api = useNotify();
  notifications = api.notifications.map((n) => n.message);
  return null;
}

function Host({
  sessionId = 'term-1',
  focus = vi.fn(),
}: {
  sessionId?: string;
  focus?: () => void;
}) {
  const h = useTerminalDragDrop({ sessionId, focus });
  useEffect(() => {
    handlers = h;
    return () => {
      handlers = null;
    };
  }, [h]);
  return <div data-testid="host" onDragOver={h.onDragOver} onDrop={h.onDrop} />;
}

function makeSession(
  id = 'term-1',
  shellFamily: 'posix' | 'cmd' | 'powershell' = 'posix',
): TerminalSession & { shellFamily: 'posix' | 'cmd' | 'powershell' } {
  return {
    id,
    title: 'Terminal 1',
    cwd: '/Users/a',
    originHint: 'user',
    createdAt: 1,
    exitCode: null,
    ownerWindowId: 1,
    shellFamily,
  };
}

function setPathMap(files: readonly File[], paths: readonly string[]): void {
  mocks.getPathForFile.mockImplementation((file) => {
    const idx = files.indexOf(file);
    return idx === -1 ? '' : (paths[idx] ?? '');
  });
}

function file(name: string): File {
  return new File(['x'], name);
}

function dragEvent(files: readonly File[]) {
  return {
    dataTransfer: {
      files,
      types: ['Files'],
      dropEffect: 'none',
    },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.DragEvent<HTMLDivElement> & {
    preventDefault: ReturnType<typeof vi.fn>;
    stopPropagation: ReturnType<typeof vi.fn>;
    dataTransfer: { dropEffect: string };
  };
}

async function drop(files: readonly File[], paths: readonly string[]) {
  setPathMap(files, paths);
  const event = dragEvent(files);
  await act(async () => {
    await (handlers?.onDrop(event) as unknown as Promise<void>);
  });
  return event;
}

beforeEach(() => {
  mocks.getPathForFile.mockReset();
  mocks.write.mockReset().mockResolvedValue({ ok: true });
  notifications = [];
  useTerminalStore.setState({
    sessions: [makeSession()],
    activeId: 'term-1',
    customTitles: new Map(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  handlers = null;
  notifications = [];
  useTerminalStore.setState({
    sessions: [],
    activeId: null,
    customTitles: new Map(),
  });
});

function renderHost(focus = vi.fn()) {
  render(
    <NotificationsProvider>
      <Probe />
      <Host focus={focus} />
    </NotificationsProvider>,
  );
  return focus;
}

describe('terminal-drag-drop BDD', () => {
  it('S1 single-file drop on macOS/zsh inserts POSIX-quoted path plus trailing space', async () => {
    const focus = renderHost();
    const f = file('a.txt');

    await drop([f], ['/Users/me/a.txt']);

    expect(mocks.write).toHaveBeenCalledWith('term-1', '/Users/me/a.txt ');
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('S2 multi-file drop joins quoted paths with spaces plus one trailing space', async () => {
    renderHost();
    const a = file('a.txt');
    const b = file('b.txt');

    await drop([a, b], ['/Users/me/a.txt', '/Users/me/b.txt']);

    expect(mocks.write).toHaveBeenCalledWith(
      'term-1',
      '/Users/me/a.txt /Users/me/b.txt ',
    );
  });

  it('S3 path with spaces is single-quoted on POSIX', async () => {
    renderHost();
    const f = file('c.txt');

    await drop([f], ['/Users/a b/c.txt']);

    expect(mocks.write).toHaveBeenCalledWith('term-1', "'/Users/a b/c.txt' ");
  });

  it("S4 path with a single quote is escaped as POSIX single-quote splice", async () => {
    renderHost();
    const f = file("o'reilly.md");

    await drop([f], ["/Users/o'reilly.md"]);

    expect(mocks.write).toHaveBeenCalledWith(
      'term-1',
      "'/Users/o'\\''reilly.md' ",
    );
  });

  it('S5 directory drop inserts the directory path and stops propagation', async () => {
    renderHost();
    const dir = file('project');

    const event = await drop([dir], ['/Users/me/project']);

    expect(mocks.write).toHaveBeenCalledWith('term-1', '/Users/me/project ');
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('S6 web drag without OS path does not write and warns no_os_path', async () => {
    renderHost();
    const synthetic = file('web.png');

    await drop([synthetic], ['']);

    expect(mocks.write).not.toHaveBeenCalled();
    expect(notifications).toContain('panels.terminal.drag_drop.no_os_path');
  });

  it('S7 control-character path is rejected and counted in partial_skip', async () => {
    renderHost();
    const good = file('good.txt');
    const bad = file('evil.txt');

    await drop([good, bad], ['/Users/me/good.txt', '/Users/me/evil\nrm']);

    expect(mocks.write).toHaveBeenCalledWith('term-1', '/Users/me/good.txt ');
    expect(notifications).toContain('panels.terminal.drag_drop.partial_skip:1');
  });

  it('S8 PowerShell session uses single quotes and never double quotes', async () => {
    useTerminalStore.setState({
      sessions: [makeSession('term-1', 'powershell')],
      activeId: 'term-1',
      customTitles: new Map(),
    });
    renderHost();
    const f = file("o'reilly.txt");

    await drop([f], ["C:\\Users\\me\\o'reilly $HOME.txt"]);

    const payload = mocks.write.mock.calls[0]?.[1] ?? '';
    expect(payload).toBe("'C:\\Users\\me\\o''reilly $HOME.txt' ");
    expect(payload).not.toContain('"');
  });
});
