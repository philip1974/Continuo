// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { useLayoutEffect, useMemo } from 'react';
import type {
  DockviewGroupPanelApi,
  DockviewGroupPanelFloatingChangeEvent,
} from 'dockview-react';
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

type TestDataTransfer = DataTransfer & {
  files: readonly File[];
  types: readonly string[];
  dropEffect: string;
};

type LocationChangeEvent = DockviewGroupPanelFloatingChangeEvent;

type LocationChangeListener = (event: LocationChangeEvent) => void;
type MutableDropRef = { current: HTMLDivElement | null };
type MockLocationApi = Pick<DockviewGroupPanelApi, 'onDidLocationChange'>;

function createLocationApi(): {
  readonly api: MockLocationApi;
  readonly disposeFns: readonly ReturnType<typeof vi.fn>[];
  readonly fire: (event: LocationChangeEvent) => void;
} {
  const listeners = new Set<LocationChangeListener>();
  const disposeFns: ReturnType<typeof vi.fn>[] = [];
  const api = {
    onDidLocationChange: vi.fn((listener: LocationChangeListener) => {
      listeners.add(listener);
      const dispose = vi.fn(() => {
        listeners.delete(listener);
      });
      disposeFns.push(dispose);
      return { dispose };
    }),
  };
  return {
    api: api as unknown as MockLocationApi,
    disposeFns,
    fire: (event: LocationChangeEvent) => {
      for (const listener of Array.from(listeners)) {
        listener(event);
      }
    },
  };
}

function popoutLocationEvent(): LocationChangeEvent {
  return { location: { type: 'popout', getWindow: () => window } };
}

const DEFAULT_RECT = {
  left: 10,
  top: 20,
  right: 210,
  bottom: 120,
  width: 200,
  height: 100,
  x: 10,
  y: 20,
  toJSON: () => ({}),
} as DOMRect;

let notifications: readonly string[] = [];

if (typeof globalThis.DragEvent === 'undefined') {
  class TestDragEvent extends MouseEvent {
    readonly dataTransfer: DataTransfer | null;

    constructor(type: string, init: DragEventInit = {}) {
      super(type, init);
      this.dataTransfer = init.dataTransfer ?? null;
    }
  }
  Object.defineProperty(globalThis, 'DragEvent', {
    configurable: true,
    value: TestDragEvent,
  });
  Object.defineProperty(window, 'DragEvent', {
    configurable: true,
    value: TestDragEvent,
  });
}

function Probe() {
  const api = useNotify();
  notifications = api.notifications.map((n) => n.message);
  return null;
}

function Host({
  sessionId = 'term-1',
  focus = vi.fn(),
  api,
  ownerDocument,
  onHookRef,
}: {
  sessionId?: string;
  focus?: () => void;
  api?: MockLocationApi;
  ownerDocument?: () => Document;
  onHookRef?: (ref: MutableDropRef) => void;
}) {
  const defaultApi = useMemo(() => createLocationApi().api, []);
  const { ref } = useTerminalDragDrop({ sessionId, focus, api: api ?? defaultApi });
  useLayoutEffect(() => {
    const dropZone = ref.current;
    if (dropZone && ownerDocument) {
      Object.defineProperty(dropZone, 'ownerDocument', {
        configurable: true,
        get: ownerDocument,
      });
    }
    onHookRef?.(ref as MutableDropRef);
  }, [onHookRef, ownerDocument, ref]);
  return (
    <div
      ref={ref}
      data-testid={`host-${sessionId}`}
      data-terminal-drop-zone={sessionId}
    />
  );
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

function dataTransfer(files: readonly File[]): TestDataTransfer {
  return {
    files,
    types: ['Files'],
    dropEffect: 'none',
  } as unknown as TestDataTransfer;
}

function dragEvent(
  type: 'dragover' | 'drop',
  files: readonly File[],
  point = { clientX: 50, clientY: 60 },
): DragEvent {
  return new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: point.clientX,
    clientY: point.clientY,
    dataTransfer: dataTransfer(files),
  });
}

function stubRect(element: Element, rect: DOMRect = DEFAULT_RECT): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect);
}

function addBubbleSentinels(): {
  readonly hits: string[];
  readonly cleanup: () => void;
} {
  const hits: string[] = [];
  const onDocument = (e: Event) => hits.push(`document:${e.type}`);
  const onWindow = (e: Event) => hits.push(`window:${e.type}`);
  document.addEventListener('dragover', onDocument);
  document.addEventListener('drop', onDocument);
  window.addEventListener('dragover', onWindow);
  window.addEventListener('drop', onWindow);
  return {
    hits,
    cleanup: () => {
      document.removeEventListener('dragover', onDocument);
      document.removeEventListener('drop', onDocument);
      window.removeEventListener('dragover', onWindow);
      window.removeEventListener('drop', onWindow);
    },
  };
}

async function settleDrop(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function drop(
  target: EventTarget,
  files: readonly File[],
  paths: readonly string[],
  point = { clientX: 50, clientY: 60 },
) {
  setPathMap(files, paths);
  const sentinel = addBubbleSentinels();
  const dragover = dragEvent('dragover', files, point);
  const dropped = dragEvent('drop', files, point);

  await act(async () => {
    target.dispatchEvent(dragover);
    target.dispatchEvent(dropped);
    await settleDrop();
  });

  sentinel.cleanup();
  return { dragover, dropped, sentinelHits: sentinel.hits };
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
  notifications = [];
  useTerminalStore.setState({
    sessions: [],
    activeId: null,
    customTitles: new Map(),
  });
});

function renderHost(
  focus = vi.fn(),
  sessionId = 'term-1',
  options: {
    readonly api?: MockLocationApi;
    readonly ownerDocument?: () => Document;
    readonly onHookRef?: (ref: MutableDropRef) => void;
  } = {},
): {
  readonly dropZone: HTMLElement;
  readonly focus: () => void;
} {
  const view = render(
    <NotificationsProvider>
      <Probe />
      <Host
        focus={focus}
        sessionId={sessionId}
        api={options.api}
        ownerDocument={options.ownerDocument}
        onHookRef={options.onHookRef}
      />
    </NotificationsProvider>,
  );
  const dropZone = view.container.querySelector(
    `[data-terminal-drop-zone="${sessionId}"]`,
  );
  if (!(dropZone instanceof HTMLElement)) {
    throw new Error(`missing terminal drop zone for ${sessionId}`);
  }
  stubRect(dropZone);
  return { dropZone, focus };
}

describe('terminal-drag-drop BDD', () => {
  it('S1 single-file drop on macOS/zsh inserts POSIX-quoted path plus trailing space', async () => {
    const { dropZone, focus } = renderHost();
    const f = file('a.txt');

    const event = await drop(dropZone, [f], ['/Users/me/a.txt']);

    expect(mocks.write).toHaveBeenCalledWith('term-1', '/Users/me/a.txt ');
    expect(focus).toHaveBeenCalledTimes(1);
    expect(event.sentinelHits).toEqual([]);
  });

  it('S2 multi-file drop joins quoted paths with spaces plus one trailing space', async () => {
    const { dropZone } = renderHost();
    const a = file('a.txt');
    const b = file('b.txt');

    await drop(dropZone, [a, b], ['/Users/me/a.txt', '/Users/me/b.txt']);

    expect(mocks.write).toHaveBeenCalledWith(
      'term-1',
      '/Users/me/a.txt /Users/me/b.txt ',
    );
  });

  it('S3 path with spaces is single-quoted on POSIX', async () => {
    const { dropZone } = renderHost();
    const f = file('c.txt');

    await drop(dropZone, [f], ['/Users/a b/c.txt']);

    expect(mocks.write).toHaveBeenCalledWith('term-1', "'/Users/a b/c.txt' ");
  });

  it("S4 path with a single quote is escaped as POSIX single-quote splice", async () => {
    const { dropZone } = renderHost();
    const f = file("o'reilly.md");

    await drop(dropZone, [f], ["/Users/o'reilly.md"]);

    expect(mocks.write).toHaveBeenCalledWith(
      'term-1',
      "'/Users/o'\\''reilly.md' ",
    );
  });

  it('S5 directory drop inserts the directory path and stops propagation', async () => {
    const { dropZone } = renderHost();
    const dir = file('project');

    const event = await drop(dropZone, [dir], ['/Users/me/project']);

    expect(mocks.write).toHaveBeenCalledWith('term-1', '/Users/me/project ');
    expect(event.dropped.defaultPrevented).toBe(true);
    expect(event.sentinelHits).toEqual([]);
  });

  it('S6 web drag without OS path does not write and warns no_os_path', async () => {
    const { dropZone } = renderHost();
    const synthetic = file('web.png');

    await drop(dropZone, [synthetic], ['']);

    expect(mocks.write).not.toHaveBeenCalled();
    expect(notifications).toContain('panels.terminal.drag_drop.no_os_path');
  });

  it('S7 control-character path is rejected and counted in partial_skip', async () => {
    const { dropZone } = renderHost();
    const good = file('good.txt');
    const bad = file('evil.txt');

    await drop(dropZone, [good, bad], ['/Users/me/good.txt', '/Users/me/evil\nrm']);

    expect(mocks.write).toHaveBeenCalledWith('term-1', '/Users/me/good.txt ');
    expect(notifications).toContain('panels.terminal.drag_drop.partial_skip:1');
  });

  it('S8 PowerShell session uses single quotes and never double quotes', async () => {
    useTerminalStore.setState({
      sessions: [makeSession('term-1', 'powershell')],
      activeId: 'term-1',
      customTitles: new Map(),
    });
    const { dropZone } = renderHost();
    const f = file("o'reilly.txt");

    await drop(dropZone, [f], ["C:\\Users\\me\\o'reilly $HOME.txt"]);

    const payload = mocks.write.mock.calls[0]?.[1] ?? '';
    expect(payload).toBe("'C:\\Users\\me\\o''reilly $HOME.txt' ");
    expect(payload).not.toContain('"');
  });

  it('S9 unmatched document.body drop does not write and still bubbles', async () => {
    const { dropZone } = renderHost();
    const f = file('outside.txt');
    stubRect(dropZone);

    const event = await drop(
      document.body,
      [f],
      ['/Users/me/outside.txt'],
      { clientX: 1000, clientY: 1000 },
    );

    expect(mocks.write).not.toHaveBeenCalled();
    expect(event.sentinelHits).toEqual([
      'document:dragover',
      'window:dragover',
      'document:drop',
      'window:drop',
    ]);
  });

  it("S10 two panels only write the owner session whose bbox contains the drop", async () => {
    useTerminalStore.setState({
      sessions: [makeSession('term-a'), makeSession('term-b')],
      activeId: 'term-a',
      customTitles: new Map(),
    });
    const view = render(
      <NotificationsProvider>
        <Probe />
        <Host sessionId="term-a" />
        <Host sessionId="term-b" />
      </NotificationsProvider>,
    );
    const zoneA = view.container.querySelector('[data-terminal-drop-zone="term-a"]');
    const zoneB = view.container.querySelector('[data-terminal-drop-zone="term-b"]');
    if (!(zoneA instanceof HTMLElement) || !(zoneB instanceof HTMLElement)) {
      throw new Error('missing terminal drop zones');
    }
    stubRect(zoneA, DEFAULT_RECT);
    stubRect(zoneB, {
      ...DEFAULT_RECT,
      left: 300,
      right: 500,
      x: 300,
    } as DOMRect);
    const f = file('a.txt');

    await drop(zoneA, [f], ['/Users/me/a.txt']);

    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(mocks.write).toHaveBeenCalledWith('term-a', '/Users/me/a.txt ');
  });

  it('S11 unmounted panel cleans up native capture listeners', async () => {
    const view = render(
      <NotificationsProvider>
        <Probe />
        <Host />
      </NotificationsProvider>,
    );
    const dropZone = view.container.querySelector('[data-terminal-drop-zone="term-1"]');
    if (!(dropZone instanceof HTMLElement)) {
      throw new Error('missing terminal drop zone');
    }
    stubRect(dropZone);
    view.unmount();
    const f = file('after-unmount.txt');

    await expect(
      drop(document.body, [f], ['/Users/me/after-unmount.txt']),
    ).resolves.toBeDefined();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('S12 location-change rebinds to new ownerDocument', async () => {
    const location = createLocationApi();
    const docA = document.implementation.createHTMLDocument('A');
    const docB = document.implementation.createHTMLDocument('B');
    let ownerDoc = docA;
    const { dropZone } = renderHost(undefined, 'term-1', {
      api: location.api,
      ownerDocument: () => ownerDoc,
    });
    stubRect(dropZone);

    location.fire(popoutLocationEvent());
    ownerDoc = docB;
    await flushMicrotasks();

    const f = file('popout.txt');
    await drop(docB, [f], ['/Users/me/popout.txt']);
    expect(mocks.write).toHaveBeenCalledWith('term-1', '/Users/me/popout.txt ');

    mocks.write.mockClear();
    await drop(docA, [f], ['/Users/me/main.txt']);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('S13 popout → grid round-trip cleans up', async () => {
    const location = createLocationApi();
    const docA = document.implementation.createHTMLDocument('A');
    const docB = document.implementation.createHTMLDocument('B');
    let ownerDoc = docA;
    const { dropZone } = renderHost(undefined, 'term-1', {
      api: location.api,
      ownerDocument: () => ownerDoc,
    });
    stubRect(dropZone);

    location.fire(popoutLocationEvent());
    ownerDoc = docB;
    await flushMicrotasks();
    location.fire({ location: { type: 'grid' } });
    ownerDoc = docA;
    await flushMicrotasks();

    const f = file('roundtrip.txt');
    await drop(docB, [f], ['/Users/me/from-popout.txt']);
    expect(mocks.write).not.toHaveBeenCalled();

    await drop(docA, [f], ['/Users/me/from-grid.txt']);
    expect(mocks.write).toHaveBeenCalledWith('term-1', '/Users/me/from-grid.txt ');
  });

  it('S14 panel unmount disposes subscription', () => {
    const location = createLocationApi();
    const view = render(
      <NotificationsProvider>
        <Probe />
        <Host api={location.api} />
      </NotificationsProvider>,
    );

    view.unmount();

    expect(location.disposeFns[0]).toHaveBeenCalledTimes(1);
  });

  it('S15 microtask race: ref.current goes null between event and microtask', async () => {
    const location = createLocationApi();
    const docA = document.implementation.createHTMLDocument('A');
    const docB = document.implementation.createHTMLDocument('B');
    let ownerDoc = docA;
    const hookRef: { value: MutableDropRef | null } = { value: null };
    const addB = vi.spyOn(docB, 'addEventListener');
    const { dropZone } = renderHost(undefined, 'term-1', {
      api: location.api,
      ownerDocument: () => ownerDoc,
      onHookRef: (ref) => {
        hookRef.value = ref;
      },
    });
    stubRect(dropZone);

    location.fire(popoutLocationEvent());
    ownerDoc = docB;
    if (hookRef.value) hookRef.value.current = null;

    await expect(flushMicrotasks()).resolves.toBeUndefined();
    expect(addB).not.toHaveBeenCalled();
  });

  it('S16 idempotent rebind on same ownerDocument', async () => {
    const location = createLocationApi();
    const docA = document.implementation.createHTMLDocument('A');
    const addA = vi.spyOn(docA, 'addEventListener');
    const { dropZone } = renderHost(undefined, 'term-1', {
      api: location.api,
      ownerDocument: () => docA,
    });
    stubRect(dropZone);

    location.fire(popoutLocationEvent());
    location.fire(popoutLocationEvent());
    await flushMicrotasks();

    expect(addA).toHaveBeenCalledTimes(3);
  });
});
