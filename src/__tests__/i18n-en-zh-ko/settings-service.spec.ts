import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
// 边界(E164):readFileCappedFd 经 node:fs 的 promises `open`,故 EACCES 须 spy 该对象(非
// node:fs/promises 默认导出 —— vitest 下二者为不同 namespace)。
import { promises as nodeFsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Locale = 'en' | 'zh' | 'ko';
type SettingsData = { readonly version: 1; readonly locale: Locale };
type SettingsServiceModule = {
  readonly mapSystemLocale: (locale: string) => Locale;
  readonly loadSettings: () => Promise<SettingsData>;
  readonly saveSettings: (settings: SettingsData) => Promise<void>;
  readonly _resetSettingsForTest: () => void;
};

let currentTmpDir = '';

const electronMock = vi.hoisted(() => ({
  app: {
    getLocale: vi.fn<() => string>(() => 'zh-CN'),
    getPath: vi.fn<(name: string) => string>(),
  },
}));

vi.mock('electron', () => electronMock);

async function importPending<T>(moduleId: string): Promise<T> {
  return (await import(moduleId)) as T;
}

beforeEach(async () => {
  currentTmpDir = path.join(
    os.tmpdir(),
    `continuo-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(currentTmpDir, { recursive: true });
  electronMock.app.getPath.mockReturnValue(currentTmpDir);
  const service = await importPending<SettingsServiceModule>(
    '../../../electron/main/services/settings.service',
  );
  service._resetSettingsForTest();
});

afterEach(async () => {
  await fs.rm(currentTmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('settings.service (settings.json) — P2-1 表驱动', () => {
  it('缺文件时返回默认 { version:1, locale: mapSystemLocale(app.getLocale()) }', async () => {
    const service = await importPending<SettingsServiceModule>(
      '../../../electron/main/services/settings.service',
    );

    await expect(service.loadSettings()).resolves.toEqual({
      version: 1,
      locale: 'zh',
    });
  });

  it('解析失败时备份 .corrupt 并重置为默认', async () => {
    const service = await importPending<SettingsServiceModule>(
      '../../../electron/main/services/settings.service',
    );
    await fs.writeFile(path.join(currentTmpDir, 'settings.json'), '{bad json', 'utf-8');

    await expect(service.loadSettings()).resolves.toEqual({
      version: 1,
      locale: 'zh',
    });
    const files = await fs.readdir(currentTmpDir);
    expect(files.some((file) => file.startsWith('settings.json.corrupt.'))).toBe(
      true,
    );
  });

  it('load → save → load 圆环一致', async () => {
    const service = await importPending<SettingsServiceModule>(
      '../../../electron/main/services/settings.service',
    );
    const settings: SettingsData = { version: 1, locale: 'ko' };

    await service.saveSettings(settings);

    await expect(service.loadSettings()).resolves.toEqual(settings);
  });

  it('saveSettings 写入相同 settings 时不重复原子写盘', async () => {
    const service = await importPending<SettingsServiceModule>(
      '../../../electron/main/services/settings.service',
    );
    const renameSpy = vi.spyOn(fs, 'rename');
    const settings: SettingsData = { version: 1, locale: 'ko' };

    try {
      await service.saveSettings(settings);
      const callsAfterFirstWrite = renameSpy.mock.calls.length;
      expect(callsAfterFirstWrite).toBeGreaterThan(0);

      await service.saveSettings({ version: 1, locale: 'ko' });

      expect(renameSpy.mock.calls).toHaveLength(callsAfterFirstWrite);
    } finally {
      renameSpy.mockRestore();
    }
  });

  // 数据安全(codex 复查 P2):settings.json 真实读错误(EACCES/EIO)此前与解析失败混为
  // 一谈,缓存默认 → 后续 saveSettings 写回覆盖已存 locale。EACCES 须返回默认但不缓存
  // (不污染、可重试恢复),仅 ENOENT/损坏才缓存默认。
  it('EACCES 读错误 → 返回默认但不缓存(不污染,下次重试读到真实值)', async () => {
    const service = await importPending<SettingsServiceModule>(
      '../../../electron/main/services/settings.service',
    );
    // 盘上有真实 locale 'ko'
    await fs.writeFile(
      path.join(currentTmpDir, 'settings.json'),
      JSON.stringify({ version: 1, locale: 'ko' }),
      'utf-8',
    );
    const spy = vi
      .spyOn(nodeFsPromises, 'open')
      .mockRejectedValueOnce(
        Object.assign(new Error('EACCES'), { code: 'EACCES' }),
      );

    // 读错误 → 降级默认(zh,来自 mock app.getLocale)
    await expect(service.loadSettings()).resolves.toEqual({
      version: 1,
      locale: 'zh',
    });
    spy.mockRestore();

    // 未缓存 → 下次 loadSettings 重试读到真实 'ko'(瞬时错误恢复,默认未污染 cache)
    await expect(service.loadSettings()).resolves.toEqual({
      version: 1,
      locale: 'ko',
    });
  });

  // 边界(E69,E18/E26/E66/E67/E68 stat-before-read 族;E164 TOCTOU 修正):settings.json 读经单 fd
  // fstat 硬拦(64KiB)。超大 = 损坏/恶意 → 当 corrupt 隔离(rename .corrupt + 默认),不整块读入。
  // 用真实超大文件(>64KiB,合法 JSON)→ 证明按 size 拦(若无 cap 会读到该 locale),覆盖单 fd fstat。
  it('E69/E164 文件超 64KiB(单 fd fstat 预检)→ rename .corrupt + 默认', async () => {
    const service = await importPending<SettingsServiceModule>(
      '../../../electron/main/services/settings.service',
    );
    // 合法 JSON 但用大 pad 撑过 64KiB(证明拦在 parse 之前,且 locale 故意设 ko)
    const huge = JSON.stringify({
      version: 1,
      locale: 'ko',
      pad: 'x'.repeat(64 * 1024 + 1),
    });
    await fs.writeFile(path.join(currentTmpDir, 'settings.json'), huge, 'utf-8');
    // 超限 → 默认(zh,来自 mock app.getLocale),不读真实 'ko'
    await expect(service.loadSettings()).resolves.toEqual({
      version: 1,
      locale: 'zh',
    });
    // 原文件被 rename 为 .corrupt 隔离
    const files = await fs.readdir(currentTmpDir);
    expect(files.some((f) => f.startsWith('settings.json.corrupt.'))).toBe(true);
    expect(files.includes('settings.json')).toBe(false);
  });

  it.each([
    ['zh-CN', 'zh'],
    ['zh-TW', 'zh'],
    ['zh-HK', 'zh'],
    ['ko-KR', 'ko'],
    ['ko', 'ko'],
    ['en-US', 'en'],
    ['en-GB', 'en'],
    ['en', 'en'],
    ['de-DE', 'en'],
    ['ja-JP', 'en'],
  ] as const)('mapSystemLocale(%s) -> %s', async (input, expected) => {
    const { mapSystemLocale } = await importPending<SettingsServiceModule>(
      '../../../electron/main/services/settings.service',
    );

    expect(mapSystemLocale(input)).toBe(expected);
  });

  it('mapSystemLocale 不通过 split 物化 locale 段数组', async () => {
    const { mapSystemLocale } = await importPending<SettingsServiceModule>(
      '../../../electron/main/services/settings.service',
    );
    const splitSpy = vi.spyOn(String.prototype, 'split');

    try {
      expect(mapSystemLocale('zh-CN')).toBe('zh');
      expect(splitSpy).not.toHaveBeenCalled();
    } finally {
      splitSpy.mockRestore();
    }
  });
});
