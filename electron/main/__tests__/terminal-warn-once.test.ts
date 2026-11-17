import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn((key: string) => `/tmp/test-${key}`) },
  BrowserWindow: {},
}));
vi.mock('../services/settings.service', () => ({
  getCurrentLocale: vi.fn(() => 'en'),
}));

import {
  WARN_ONCE_MAX_KEYS,
  _warnedKeyCount,
  warnOnce,
} from '../services/terminal.service';

afterEach(() => {
  vi.restoreAllMocks();
});

// warnOnce 的 key 含会话 id:按会话去重的告警集合须有界,不随历史会话数单调增长。
describe('terminal.service warnOnce', () => {
  it('同 key 只告警一次,不同 key 各告警一次', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnOnce('t:same', 'a');
    warnOnce('t:same', 'a');
    warnOnce('t:other', 'b');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('大量不同会话 key → 去重集合不超过容量上限', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < WARN_ONCE_MAX_KEYS * 3; i += 1) warnOnce(`sendInput:s${i}`, 'x');
    expect(_warnedKeyCount()).toBeLessThanOrEqual(WARN_ONCE_MAX_KEYS);
  });
});
