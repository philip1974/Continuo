// @vitest-environment jsdom
// 外部重读遇到「文件已超过读取上限」(FS_FILE_TOO_LARGE,如持续写入的日志涨过 64 MiB):明确提示「已停止自动刷新」,同一文件
// 只提示一次;tab 内容不动;文件变小后读成功即恢复自动刷新,之后再超限会再提示。读取上限用桩(readFile 直接返回错误码),不建大文件。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/notifications/notify', () => ({ notify: { warn: h.warn, error: vi.fn(), info: vi.fn() } }));

import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { tooLargeNotifyKey, useExternalFileSync } from '../../panels/Editor/useExternalFileSync';
import { useEditorStore } from '../../stores/editor.store';
import { flushMicrotasks } from '../_helpers/async';

let dirCb: ((dir: string, files?: readonly string[]) => void) | null = null;
let disk: { ok: true; data: string } | { ok: false; code: string } = { ok: true, data: 'x' };

beforeEach(() => {
  _resetLmApiForTest();
  h.warn.mockReset();
  dirCb = null;
  Object.defineProperty(window, 'api', {
    value: {
      fs: {
        onDirChanged: (cb: typeof dirCb) => {
          dirCb = cb;
          return () => {};
        },
        onWatchLost: () => () => {},
        onRootPresenceChanged: () => () => {},
        readFile: vi.fn(async () => disk),
        stat: vi.fn(async () => ({ ok: false, code: 'FS_IO' })),
      },
    },
    writable: true,
    configurable: true,
  });
  captureLmApi();
  useEditorStore.setState({
    tabs: [{ id: '/logs/app.log', filePath: '/logs/app.log', content: 'old', originalContent: 'old', dirty: false }],
    activeTabId: '/logs/app.log',
  });
});
afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
});

const change = async () => {
  dirCb!('/logs', ['app.log']);
  await flushMicrotasks(6);
};
const content = () => useEditorStore.getState().tabs[0]?.content;

describe('外部重读时文件已超过读取上限', () => {
  it('提示一次「已停止自动刷新」(按文件合并),内容不动;变小后恢复;再超限再提示', async () => {
    renderHook(() => useExternalFileSync());
    disk = { ok: false, code: 'FS_FILE_TOO_LARGE' };
    await change();
    expect(h.warn).toHaveBeenCalledTimes(1);
    const [message, opts] = h.warn.mock.calls[0]!;
    expect(message).toContain('app.log');
    expect(opts).toEqual({ replaceKey: tooLargeNotifyKey('/logs/app.log') });
    expect(content()).toBe('old');

    await change();
    expect(h.warn).toHaveBeenCalledTimes(1);

    disk = { ok: true, data: 'rotated' };
    await change();
    expect(content()).toBe('rotated');

    disk = { ok: false, code: 'FS_FILE_TOO_LARGE' };
    await change();
    expect(h.warn).toHaveBeenCalledTimes(2);
  });

  it('其它读失败(如无权限)不提示', async () => {
    renderHook(() => useExternalFileSync());
    disk = { ok: false, code: 'FS_DENIED' };
    await change();
    expect(h.warn).not.toHaveBeenCalled();
  });
});
