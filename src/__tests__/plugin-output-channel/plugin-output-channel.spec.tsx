// @vitest-environment jsdom
// BDD: plugin-output-channel(见同目录 README)。
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: {
      _registerPlugin: async () => ({ token: 't', generation: 1 }),
      _unregisterPlugin: async () => undefined,
    },
  },
}));

import { setLocale } from '@/i18n/translate';
import {
  OUTPUT_MAX_CHARS,
  OUTPUT_MAX_LINES,
  _resetOutputChannelsForTest,
  appendToOutputChannel,
  ensureOutputChannel,
  getActiveOutputChannelId,
  listOutputChannels,
  pluginOutputChannelId,
  readOutputChannel,
  removeOutputChannel,
} from '../../plugins/output/output-channels';
import { createScopedAppController, OUTPUT_CHANNELS_PER_PLUGIN_MAX } from '../../plugins/scoped-app';
import { createTestCoApp } from '../../plugins/test-utils';
import { Plugin } from '../../plugins/Plugin';
import { PluginManager, setUserPluginManager, type PluginDirInfo } from '../../plugins/PluginManager';
import { installPluginErrorCapture, logPluginErrorFromStack } from '../../plugins/output/plugin-error-capture';
import { Output } from '../../panels/Output';

beforeEach(() => {
  setLocale('en');
  _resetOutputChannelsForTest();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setUserPluginManager(null as never);
  setLocale('zh');
});

const text = (id: string) => readOutputChannel(id).text;

describe('通道内容:按行追加、环形缓冲上限、清除', () => {
  it('append 不换行、appendLine 换行;\\r\\n 归一', () => {
    ensureOutputChannel('c', 'C', null);
    appendToOutputChannel('c', 'a');
    appendToOutputChannel('c', 'b\r\nc\n');
    appendToOutputChannel('c', 'd');
    expect(text('c')).toBe('ab\nc\nd');
  });

  it('超过行数上限 → 丢最早的行,保留最近 OUTPUT_MAX_LINES 行', () => {
    ensureOutputChannel('c', 'C', null);
    appendToOutputChannel('c', Array.from({ length: OUTPUT_MAX_LINES + 5 }, (_, i) => `l${i}\n`).join(''));
    const snap = readOutputChannel('c');
    expect(snap.lineCount).toBe(OUTPUT_MAX_LINES);
    expect(snap.text.startsWith('l5\n')).toBe(true);
    expect(snap.text.endsWith(`l${OUTPUT_MAX_LINES + 4}`)).toBe(true);
  });

  it('超过总字符上限 → 丢最早的行', () => {
    ensureOutputChannel('c', 'C', null);
    const line = 'x'.repeat(9_000);
    for (let i = 0; i < 300; i += 1) appendToOutputChannel('c', `${i}${line}\n`);
    expect(text('c').length).toBeLessThanOrEqual(OUTPUT_MAX_CHARS + OUTPUT_MAX_LINES);
    expect(text('c').startsWith('0x')).toBe(false);
    expect(text('c').includes(`299${line}`)).toBe(true);
  });

  it('移除活动通道 → 活动通道换成剩下的第一个', () => {
    ensureOutputChannel('a', 'A', null);
    ensureOutputChannel('b', 'B', null);
    expect(getActiveOutputChannelId()).toBe('a');
    removeOutputChannel('a');
    expect(getActiveOutputChannelId()).toBe('b');
  });
});

describe('app.output(插件 SDK)', () => {
  const coApp = createTestCoApp('1.0.0');

  it('默认通道以插件名命名;appendLine / append / clear;非字符串 → BAD_INPUT', () => {
    const { app } = createScopedAppController(coApp, 'com.x', null, 'tok', [], 'X Plugin');
    expect(app.output.name).toBe('X Plugin');
    app.output.appendLine('hello');
    app.output.append('wor');
    app.output.append('ld');
    expect(listOutputChannels()).toEqual([{ id: pluginOutputChannelId('com.x'), name: 'X Plugin', ownerId: 'com.x' }]);
    expect(text(pluginOutputChannelId('com.x'))).toBe('hello\nworld');
    expect(() => app.output.appendLine({} as never)).toThrow(expect.objectContaining({ code: 'BAD_INPUT' }));
    app.output.clear();
    expect(text(pluginOutputChannelId('com.x'))).toBe('');
  });

  it('show → 切到本通道并执行「显示输出」命令', () => {
    const fn = vi.fn();
    coApp.commands.register({ id: 'workbench.view.output', title: 'Show Output', fn });
    ensureOutputChannel('other', 'Other', null);
    const { app } = createScopedAppController(coApp, 'com.x', null, 'tok', [], 'X');
    app.output.show();
    expect(getActiveOutputChannelId()).toBe(pluginOutputChannelId('com.x'));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('createOutputChannel:额外通道、dispose 移除、数量上限;停用时移除额外通道,默认通道保留且仍可写,show 拒绝', () => {
    const ctl = createScopedAppController(coApp, 'com.x', null, 'tok', [], 'X');
    const extra = ctl.app.output.createOutputChannel('Trace');
    extra.appendLine('t1');
    ctl.app.output.appendLine('d1');
    expect(listOutputChannels().map((c) => c.name)).toEqual(['Trace', 'X']);
    for (let i = 1; i < OUTPUT_CHANNELS_PER_PLUGIN_MAX; i += 1) ctl.app.output.createOutputChannel(`c${i}`);
    expect(() => ctl.app.output.createOutputChannel('one too many')).toThrow(expect.objectContaining({ code: 'BAD_INPUT' }));
    extra.dispose();
    expect(listOutputChannels().map((c) => c.name)).not.toContain('Trace');

    ctl.revoke();
    expect(listOutputChannels().map((c) => c.name)).toEqual(['X']);
    ctl.app.output.appendLine('from onunload');
    expect(text(pluginOutputChannelId('com.x'))).toBe('d1\nfrom onunload');
    expect(() => ctl.app.output.show()).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    expect(() => ctl.app.output.createOutputChannel('late')).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
  });
});

describe('宿主写入:激活失败、加载跳过原因、运行时错误;卸载移除通道', () => {
  const dir = (id: string, manifest: object | string = {}): PluginDirInfo => ({
    id,
    manifestText: typeof manifest === 'string' ? manifest : JSON.stringify({ id, name: `${id} name`, version: '1.0.0', ...manifest }),
    moduleUrl: `mod://${id}`,
  });

  it('onload 抛错 → 该插件通道记 [error] 本地化原因(带位置);无效目录 → 记「未加载」原因一次', async () => {
    class Throws extends Plugin {
      onload() {
        const e = new Error('boom');
        e.stack = 'Error: boom\n    at Throws.onload (continuo-plugin://t/main.js:8:5)';
        throw e;
      }
    }
    const state = { dirs: [dir('t'), dir('bad', { version: 'x' })] };
    const mgr = new PluginManager(createTestCoApp('1.0.0'), {
      listPluginDirs: () => state.dirs,
      readEnabledIds: () => new Set(['t']),
      mutateEnabledId: () => {},
      importModule: async () => ({ default: Throws }),
      removePluginDir: async () => {},
    });
    await mgr.init();
    expect(text(pluginOutputChannelId('t'))).toMatch(
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} \[error\] Activation failed: boom \(main\.js:8:5\)$/,
    );
    expect(listOutputChannels().find((c) => c.id === pluginOutputChannelId('t'))?.name).toBe('t name');
    expect(text(pluginOutputChannelId('bad'))).toMatch(/\[error\] Not loaded: manifest\.json is invalid: version: must be a version like 1\.2\.3$/);
    await mgr.handleDirChanged('bad'); // 同一原因再扫描不重复记
    expect(text(pluginOutputChannelId('bad')).split('\n')).toHaveLength(1);

    await mgr.uninstall('t');
    expect(listOutputChannels().map((c) => c.id)).not.toContain(pluginOutputChannelId('t'));
  });

  it('未捕获错误 / 未处理拒绝:堆栈里有已登记插件的帧 → 写进它的通道(附堆栈);无插件帧 → 不记', async () => {
    class Ok extends Plugin {
      onload() {}
    }
    const mgr = new PluginManager(createTestCoApp('1.0.0'), {
      listPluginDirs: () => [dir('p')],
      readEnabledIds: () => new Set(['p']),
      mutateEnabledId: () => {},
      importModule: async () => ({ default: Ok }),
    });
    await mgr.init();
    setUserPluginManager(mgr);
    const uninstall = installPluginErrorCapture(window);
    try {
      const err = new Error('late boom');
      err.stack = 'Error: late boom\n    at Timeout._onTimeout (continuo-plugin://p/main.js:3:11)';
      window.dispatchEvent(new ErrorEvent('error', { error: err, message: err.message }));
      expect(text(pluginOutputChannelId('p'))).toContain('[error] Uncaught error: late boom\nError: late boom\n    at Timeout._onTimeout (continuo-plugin://p/main.js:3:11)');
      const before = text(pluginOutputChannelId('p'));
      window.dispatchEvent(new ErrorEvent('error', { error: new Error('host bug'), message: 'host bug' }));
      expect(text(pluginOutputChannelId('p'))).toBe(before);
      expect(logPluginErrorFromStack(Object.assign(new Error('x'), { stack: 'at continuo-plugin://unknown/main.js:1:1' }), 'uncaught')).toBeNull();
    } finally {
      uninstall();
    }
  });
});

describe('输出面板', () => {
  it('没有通道 → 只显示空状态;有通道 → 下拉切换、清除、自动滚动开关', () => {
    const { container, unmount } = render(<Output />);
    expect(container.textContent).toBe('No output yet.');
    unmount();

    ensureOutputChannel('a', 'Alpha', 'alpha');
    ensureOutputChannel('b', 'Beta', 'beta');
    appendToOutputChannel('a', 'alpha line\n');
    appendToOutputChannel('b', 'beta line\n');
    const view = render(<Output />);
    const log = () => view.container.querySelector('[data-output-channel]')!;
    expect(log().getAttribute('data-output-channel')).toBe('a');
    expect(log().textContent).toBe('alpha line');

    const picker = view.getByRole('button', { name: 'Output channel: Alpha' });
    fireEvent.click(picker);
    fireEvent.click(view.getByRole('menuitemradio', { name: 'Beta' }));
    expect(log().textContent).toBe('beta line');
    expect(view.getByRole('button', { name: 'Output channel: Beta' })).toBeTruthy();

    fireEvent.click(view.getByRole('button', { name: 'Clear Output' }));
    expect(log().textContent).toBe('');
    act(() => appendToOutputChannel('b', 'again\n'));
    expect(log().textContent).toBe('again');

    const lock = view.getByRole('button', { name: 'Turn Auto Scrolling Off' });
    expect(lock.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(lock);
    expect(view.getByRole('button', { name: 'Turn Auto Scrolling On' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('自动滚动:内容变化时滚到底;锁定后不动', () => {
    ensureOutputChannel('a', 'Alpha', null);
    const view = render(<Output />);
    const body = view.container.querySelector<HTMLElement>('[data-output-channel]')!;
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 500 });
    act(() => appendToOutputChannel('a', 'x\n'));
    expect(body.scrollTop).toBe(500);
    fireEvent.click(view.getByRole('button', { name: 'Turn Auto Scrolling Off' }));
    body.scrollTop = 10;
    act(() => appendToOutputChannel('a', 'y\n'));
    expect(body.scrollTop).toBe(10);
  });
});
