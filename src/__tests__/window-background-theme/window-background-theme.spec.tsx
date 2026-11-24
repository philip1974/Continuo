// @vitest-environment jsdom
// 窗口底色跟随主题。见同目录 README。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_CHANNELS } from '../../../electron/shared/window-channels';
import { WINDOW_BACKGROUND_COLORS } from '../../../electron/shared/window-background';

type InvokeHandler = (event: { sender: object; senderFrame: unknown }, raw: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  // notify-theme 会把主题写进 userData:指向临时目录(下方 mkdtempSync),不写真实 /tmp
  userData: '',
  handlers: new Map<string, InvokeHandler>(),
  windows: [] as Array<{ setBackgroundColor: ReturnType<typeof vi.fn>; isDestroyed: () => boolean }>,
  notifyTheme: vi.fn(async () => ({ ok: true })),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => h.userData), on: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      h.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => ({ id: 1 })),
    getAllWindows: vi.fn(() => h.windows),
  },
}));
vi.mock('../../../electron/main/persistence', () => ({ allocateWindowSeq: vi.fn() }));
vi.mock('@/lib/co-api', () => ({ coApi: { window: { notifyTheme: h.notifyTheme } } }));

import {
  currentWindowBackgroundColor,
  registerWindowIpc,
} from '../../../electron/main/ipc/window.ipc';
import { ThemeProvider, useTheme } from '@/theme';
import { WindowBackgroundSync } from '@/theme/WindowBackgroundSync';

h.userData = mkdtempSync(join(tmpdir(), 'continuo-wbt-'));
afterAll(() => rmSync(h.userData, { recursive: true, force: true }));

const read = (rel: string): string => readFileSync(resolve(__dirname, '../../..', rel), 'utf-8');
const surface = (css: string, sel: ':root' | '.dark'): string => {
  const block =
    css.match(new RegExp(`${sel === ':root' ? ':root' : '\\.dark'}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
  return block.match(/--md-surface:\s*(#[0-9a-f]{6});/i)?.[1] ?? '';
};
const TRUSTED = { url: 'file:///app/index.html' };
const notify = (raw: unknown): Promise<unknown> => {
  const handler = h.handlers.get(WINDOW_CHANNELS.NOTIFY_THEME);
  if (!handler) throw new Error('missing notifyTheme handler');
  return handler({ sender: {}, senderFrame: TRUSTED }, raw);
};

describe('底色常量 = design-tokens 画布色', () => {
  it('dark / light 分别等于 .dark / :root 的 --md-surface', () => {
    const tokens = read('src/styles/design-tokens.css');
    expect(WINDOW_BACKGROUND_COLORS.dark).toBe(surface(tokens, '.dark'));
    expect(WINDOW_BACKGROUND_COLORS.light).toBe(surface(tokens, ':root'));
  });

  it('index.ts 两处 BrowserWindow 都经 currentWindowBackgroundColor(),不写字面色值', () => {
    const src = read('electron/main/index.ts');
    expect(src.match(/backgroundColor: currentWindowBackgroundColor\(\)/g)).toHaveLength(2);
    expect(src).not.toMatch(/backgroundColor:\s*'#/);
    expect(src).not.toMatch(/WINDOW_BACKGROUND_COLOR\s*=/);
  });
});

describe('main:window:notify-theme', () => {
  beforeEach(() => {
    h.handlers.clear();
    h.windows = [
      { setBackgroundColor: vi.fn(), isDestroyed: () => false },
      { setBackgroundColor: vi.fn(), isDestroyed: () => true },
    ];
    registerWindowIpc({ createMainWindow: vi.fn() });
  });

  it('默认暗色;上报 light → 已开窗口改底色,之后新窗口用 light 底色;再上报 dark 切回', async () => {
    expect(currentWindowBackgroundColor()).toBe(WINDOW_BACKGROUND_COLORS.dark); // 尚无上报 = 默认主题
    await notify({ theme: 'dark' });
    expect(currentWindowBackgroundColor()).toBe(WINDOW_BACKGROUND_COLORS.dark);

    await expect(notify({ theme: 'light' })).resolves.toMatchObject({ ok: true });
    expect(h.windows[0]!.setBackgroundColor).toHaveBeenLastCalledWith(WINDOW_BACKGROUND_COLORS.light);
    expect(h.windows[1]!.setBackgroundColor).not.toHaveBeenCalled(); // 已销毁的窗口跳过
    expect(currentWindowBackgroundColor()).toBe(WINDOW_BACKGROUND_COLORS.light);

    await notify({ theme: 'dark' });
    expect(h.windows[0]!.setBackgroundColor).toHaveBeenLastCalledWith(WINDOW_BACKGROUND_COLORS.dark);
    expect(currentWindowBackgroundColor()).toBe(WINDOW_BACKGROUND_COLORS.dark);
  });

  it.each([{ theme: 'system' }, { theme: 'light', extra: 1 }, { theme: '#000000' }, null])(
    '非法入参 %j → 拒绝,不改底色',
    async (raw) => {
      await notify({ theme: 'dark' });
      const r = await notify(raw);
      expect(r).toMatchObject({ ok: false });
      expect(currentWindowBackgroundColor()).toBe(WINDOW_BACKGROUND_COLORS.dark);
    },
  );
});

describe('renderer:WindowBackgroundSync 上报 resolved 主题', () => {
  afterEach(() => {
    cleanup();
    document.documentElement.classList.remove('dark');
    h.notifyTheme.mockClear();
  });

  function ModeSetter({ onReady }: { onReady: (set: (m: 'light' | 'dark') => void) => void }) {
    const { setMode } = useTheme();
    onReady(setMode);
    return null;
  }

  it('挂载上报当前主题与模式,切换主题再上报', async () => {
    let setMode: ((m: 'light' | 'dark') => void) | null = null;
    await act(async () => {
      render(
        <ThemeProvider>
          <WindowBackgroundSync />
          <ModeSetter onReady={(s) => (setMode = s)} />
        </ThemeProvider>,
      );
    });
    // 第二参 = 主题模式(system 时 main 冷启动按 OS 外观决定首窗底色)
    expect(h.notifyTheme).toHaveBeenLastCalledWith('dark', 'dark');
    await act(async () => {
      setMode!('light');
    });
    expect(h.notifyTheme).toHaveBeenLastCalledWith('light', 'light');
  });

  it('上报失败(reject)只 warn,不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.notifyTheme.mockRejectedValueOnce(new Error('ipc down'));
    await act(async () => {
      render(
        <ThemeProvider>
          <WindowBackgroundSync />
        </ThemeProvider>,
      );
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('Splash Spotlight 跟随主题前景色', () => {
  it('不写死 fill="white",用 currentColor + text-fg', () => {
    const src = read('src/shell/decor/Splash.tsx');
    expect(src).not.toContain('fill="white"');
    expect(src).toContain('fill="currentColor"');
    expect(src).toMatch(/<Spotlight[^>]*className="[^"]*\btext-fg\b/);
  });
});
