// @vitest-environment jsdom
// BDD:Explorer 行内重命名输入时校验(对齐 VSCode validateFileName)。见同目录 README。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

const h = vi.hoisted(() => ({
  notifyError: vi.fn(),
}));

const entries: FileEntry[] = [
  { path: '/work/alpha', name: 'alpha', isDirectory: true },
  { path: '/work/beta.ts', name: 'beta.ts', isDirectory: false },
  { path: '/work/bravo.ts', name: 'bravo.ts', isDirectory: false },
];
const fsTree = new Map<string, FileEntry[]>();

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (p: string) => ({ ok: true, data: fsTree.get(p) ?? [] })),
      move: vi.fn(),
      copy: vi.fn(),
      trash: vi.fn(),
      rename: vi.fn(async (p: string, n: string) => {
        const newPath = `/work/${n}`;
        const list = fsTree.get('/work') ?? [];
        fsTree.set('/work', list.map((e) => (e.path === p ? { ...e, path: newPath, name: n } : e)));
        return { ok: true, data: newPath };
      }),
      reveal: vi.fn(),
      watchDir: vi.fn(async () => ({ ok: true })),
      unwatchDir: vi.fn(async () => ({ ok: true })),
      onDirChanged: vi.fn(() => vi.fn()),
      onWatchLost: vi.fn(() => vi.fn()),
    },
    terminal: { create: vi.fn() },
  },
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 28,
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({ index: i, start: i * 28, size: 28, key: i })),
    scrollToIndex: () => {},
  }),
}));
vi.mock('@/panels/Editor/useEditorFile', () => ({
  useEditorFile: () => ({ openFileByPath: vi.fn(async () => ({ ok: true })) }),
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_key: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('@/notifications/notify', () => ({ notify: { error: h.notifyError, info: vi.fn(), success: vi.fn() } }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({ ExplorerHeader: () => null }));

import { coApi } from '@/lib/co-api';
import { FolderTree } from '../../panels/Explorer/FolderTree';
import { renameInputError } from '../../panels/Explorer/path-utils';
import { getLocale, setLocale } from '../../i18n';

const row = (container: HTMLElement, p: string) =>
  container.querySelector(`[title="${p}"]`) as HTMLElement | null;

let originalPlatform: PropertyDescriptor | undefined;
let originalLocale = getLocale();
function setPlatform(p: string): void {
  Object.defineProperty(window.navigator, 'platform', { value: p, configurable: true });
}

function key(el: HTMLElement, init: KeyboardEventInit) {
  act(() => {
    fireEvent.keyDown(el, init);
  });
  act(() => {
    fireEvent.keyUp(el, init);
  });
}

async function startRename(p: string) {
  const r = render(<FolderTree root="/work" />);
  await waitFor(() => expect(row(r.container, p)).not.toBeNull());
  act(() => {
    fireEvent.click(row(r.container, p)!);
  });
  await waitFor(() => expect(row(r.container, p)!.getAttribute('tabindex')).toBe('0'));
  key(row(r.container, p)!, { key: 'F2', code: 'F2' });
  const input = await waitFor(() => {
    const el = r.container.querySelector('input');
    expect(el).not.toBeNull();
    return el!;
  });
  await waitFor(() => expect(document.activeElement).toBe(input));
  const type = (value: string) =>
    act(() => {
      fireEvent.change(input, { target: { value } });
    });
  const alert = () => r.container.querySelector('[role="alert"]');
  return { ...r, input, type, alert };
}

beforeEach(() => {
  originalLocale = getLocale();
  setLocale('en');
  originalPlatform = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
  setPlatform('MacIntel');
  vi.mocked(coApi.fs.rename).mockClear();
  h.notifyError.mockReset();
  fsTree.clear();
  fsTree.set('/work', entries);
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
});
afterEach(() => {
  cleanup();
  setLocale(originalLocale);
  if (originalPlatform) Object.defineProperty(window.navigator, 'platform', originalPlatform);
  else delete (window.navigator as { platform?: string }).platform;
});

describe('重命名为同目录已存在的名字', () => {
  it('输入时即标红并在输入框下方提示(带名字),输入框 aria-describedby 指向提示', async () => {
    const { input, type, alert } = await startRename('/work/beta.ts');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    type('bravo.ts');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(alert()?.textContent).toBe(
      'A file or folder “bravo.ts” already exists at this location. Please choose a different name.',
    );
    expect(input.getAttribute('aria-describedby')).toBe(alert()!.id);
  });

  it('Enter 不提交、输入框与输入保留;改正后提示消失,再 Enter 提交', async () => {
    const { container, input, type, alert } = await startRename('/work/beta.ts');
    type('bravo.ts');
    key(input, { key: 'Enter', code: 'Enter' });
    await new Promise((r) => setTimeout(r, 20));
    expect(coApi.fs.rename).not.toHaveBeenCalled();
    expect(container.querySelector('input')).toBe(input);
    expect(input.value).toBe('bravo.ts');
    expect(h.notifyError).not.toHaveBeenCalled();

    type('bravo2.ts');
    expect(alert()).toBeNull();
    expect(input.getAttribute('aria-invalid')).toBeNull();
    key(input, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(coApi.fs.rename).toHaveBeenCalledWith('/work/beta.ts', 'bravo2.ts'));
  });

  it('Esc 放弃:不重命名,输入框关闭', async () => {
    const { container, input, type } = await startRename('/work/beta.ts');
    type('bravo.ts');
    key(input, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(container.querySelector('input')).toBeNull());
    expect(coApi.fs.rename).not.toHaveBeenCalled();
  });

  it('有错误时失焦 = 放弃(VSCode:失焦按输入是否有效决定提交或放弃)', async () => {
    const { container, input, type } = await startRename('/work/beta.ts');
    type('bravo.ts');
    act(() => {
      fireEvent.blur(input);
    });
    await waitFor(() => expect(container.querySelector('input')).toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    expect(coApi.fs.rename).not.toHaveBeenCalled();
    expect(h.notifyError).not.toHaveBeenCalled();
  });

  it('macOS / Windows 上只差大小写的其它项也算重名(Bravo.ts vs bravo.ts)', async () => {
    const { type, alert } = await startRename('/work/beta.ts');
    type('Bravo.ts');
    expect(alert()?.textContent).toContain('“Bravo.ts” already exists');
  });

  it('Linux(大小写敏感)上只差大小写的其它项不算重名', async () => {
    setPlatform('Linux x86_64');
    const { input, type, alert } = await startRename('/work/beta.ts');
    type('Bravo.ts');
    expect(alert()).toBeNull();
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('自身大小写变化(beta.ts → Beta.ts)不算重名,Enter 提交', async () => {
    const { input, type, alert } = await startRename('/work/beta.ts');
    type('Beta.ts');
    expect(alert()).toBeNull();
    key(input, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(coApi.fs.rename).toHaveBeenCalledWith('/work/beta.ts', 'Beta.ts'));
  });
});

describe('空名与非法名', () => {
  it('清空 → 提示必须提供名字;Enter 不提交、输入框保留', async () => {
    const { container, input, type, alert } = await startRename('/work/beta.ts');
    type('   ');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(alert()?.textContent).toBe('A file or folder name must be provided.');
    key(input, { key: 'Enter', code: 'Enter' });
    await new Promise((r) => setTimeout(r, 20));
    expect(coApi.fs.rename).not.toHaveBeenCalled();
    expect(container.querySelector('input')).toBe(input);
  });

  it.each(['a/b.ts', 'a:b.ts', 'con', 'name.'])('非法名 %s → 提示名字无效,Enter 不提交', async (bad) => {
    const { input, type, alert } = await startRename('/work/beta.ts');
    type(bad);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(alert()?.textContent).toBe(
      `The name “${bad}” is not valid as a file or folder name. Please choose a different name.`,
    );
    key(input, { key: 'Enter', code: 'Enter' });
    await new Promise((r) => setTimeout(r, 20));
    expect(coApi.fs.rename).not.toHaveBeenCalled();
  });

  it('未改名(初值)不提示', async () => {
    const { input, alert } = await startRename('/work/beta.ts');
    expect(input.value).toBe('beta.ts');
    expect(alert()).toBeNull();
  });
});

describe('提交后 main 端失败', () => {
  it('同名(如未显示的隐藏文件 / 外部刚建)→ toast 带目标名,退出重命名(VSCode 同)', async () => {
    vi.mocked(coApi.fs.rename).mockResolvedValueOnce({ ok: false, code: 'FS_EEXIST', message: 'exists' } as never);
    const { container, input, type } = await startRename('/work/beta.ts');
    type('delta.ts');
    key(input, { key: 'Enter', code: 'Enter' });
    await waitFor(() =>
      expect(h.notifyError).toHaveBeenCalledWith(
        'A file or folder “delta.ts” already exists at this location. Please choose a different name.',
        { code: 'FS_EEXIST' },
      ),
    );
    expect(container.querySelector('input')).toBeNull();
  });
});

describe('renameInputError(纯函数)', () => {
  const sib = ['beta.ts', 'bravo.ts', 'alpha'];
  it.each([
    ['beta.ts', null],
    [' beta.ts ', null],
    ['', { kind: 'empty' }],
    ['bravo.ts', { kind: 'exists', name: 'bravo.ts' }],
    [' bravo.ts ', { kind: 'exists', name: 'bravo.ts' }],
    ['BRAVO.ts', { kind: 'exists', name: 'BRAVO.ts' }],
    ['Beta.ts', null],
    ['x~1', { kind: 'invalid', name: 'x~1' }],
    ['ok.ts', null],
  ] as const)('忽略大小写:%j → %j', (raw, want) => {
    expect(renameInputError(raw, 'beta.ts', sib, true)).toEqual(want);
  });

  it('区分大小写:BRAVO.ts 不与 bravo.ts 冲突', () => {
    expect(renameInputError('BRAVO.ts', 'beta.ts', sib, false)).toBeNull();
  });

  it('原名本身含非法字符(外部创建的 a~b)未改名时不提示', () => {
    expect(renameInputError('a~b', 'a~b', ['a~b'], true)).toBeNull();
  });
});

// 对齐 VSCode InputBox 校验提示:下方(到滚动区底边)放不下而上方更宽裕 → 翻到输入框上方,不被侧栏滚动区裁掉。
describe('校验提示位置:下方空间不足翻到上方', () => {
  const SCROLLER = { top: 0, bottom: 200 };
  const HINT_HEIGHT = 40;
  let rowTop = 0;
  beforeEach(() => {
    // jsdom 无布局:滚动区(overflow-auto)、重命名输入所在行、提示框各给一个矩形。
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const rect = (top: number, height: number) =>
        ({ top, bottom: top + height, left: 0, right: 200, width: 200, height, x: 0, y: top }) as DOMRect;
      if (this.classList.contains('overflow-auto')) return rect(SCROLLER.top, SCROLLER.bottom - SCROLLER.top);
      if (this.getAttribute('role') === 'alert') return rect(0, HINT_HEIGHT);
      if (this.querySelector(':scope > input')) return rect(rowTop, 28);
      return rect(0, 0);
    });
  });
  afterEach(() => vi.restoreAllMocks());
  // jsdom 不按样式表层叠 overflow:滚动区的 overflow 以内联补上(真机由 Tailwind overflow-auto 给出)。
  async function startRenameInScroller(p: string) {
    const r = await startRename(p);
    r.container.querySelector<HTMLElement>('.overflow-auto')!.style.overflowY = 'auto';
    return r;
  }

  it('下方放得下 → 提示在输入框下方(top-full)', async () => {
    rowTop = 28;
    const { type, alert } = await startRenameInScroller('/work/beta.ts');
    type('bravo.ts');
    expect(alert()!.className).toMatch(/\btop-full\b/);
    expect(alert()!.className).not.toMatch(/\bbottom-full\b/);
  });

  it('滚动区最后一行(下方只剩 4px)→ 提示翻到输入框上方(bottom-full)', async () => {
    rowTop = SCROLLER.bottom - 28 - 4;
    const { type, alert } = await startRenameInScroller('/work/beta.ts');
    type('bravo.ts');
    expect(alert()!.className).toMatch(/\bbottom-full\b/);
    expect(alert()!.className).not.toMatch(/\btop-full\b/);
  });
});
