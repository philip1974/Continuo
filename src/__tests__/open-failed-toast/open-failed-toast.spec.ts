// BDD:打开文件失败的统一提示。见同目录 README。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { errorSpy } = vi.hoisted(() => ({ errorSpy: vi.fn() }));
vi.mock('../../notifications/notify', () => ({ notify: { error: errorSpy } }));

import { notifyOpenFailed, openFileOrNotify } from '../../notifications/notify-open-failed';
import { failureOf } from '../../lib/failure-of';
import { notifyFailure, notifyThrownError } from '../../notifications/notify-thrown-error';
import { setLocale } from '../../i18n/translate';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

beforeEach(() => {
  errorSpy.mockClear();
  setLocale('en');
});

describe('notifyOpenFailed', () => {
  it('ok:false(catalog 收录的 code)→ 「Failed to open <name>: <本地化原因>」并附 code', () => {
    notifyOpenFailed('a.md', { code: 'FS_EEXIST', message: 'raw' });
    expect(errorSpy).toHaveBeenCalledWith('Failed to open a.md: Already exists', {
      code: 'FS_EEXIST',
    });
  });

  it('未收录的 code → 原因回退原 message;无 message 回退 code', () => {
    notifyOpenFailed('a.md', { code: 'NO_SUCH_CODE_X', message: 'disk on fire' });
    expect(errorSpy).toHaveBeenLastCalledWith('Failed to open a.md: disk on fire', {
      code: 'NO_SUCH_CODE_X',
    });
    notifyOpenFailed('a.md', { code: 'NO_SUCH_CODE_X' });
    expect(errorSpy).toHaveBeenLastCalledWith('Failed to open a.md: NO_SUCH_CODE_X', {
      code: 'NO_SUCH_CODE_X',
    });
  });

  it('mirror:false 透传', () => {
    notifyOpenFailed('a.md', { code: 'NO_SUCH_CODE_X', message: 'm' }, { mirror: false });
    expect(errorSpy).toHaveBeenCalledWith('Failed to open a.md: m', {
      code: 'NO_SUCH_CODE_X',
      mirror: false,
    });
  });
});

describe('failureOf(抛出值 → 失败描述)', () => {
  it('带 code 的 Error → 该 code + message', () => {
    expect(failureOf(Object.assign(new Error('nope'), { code: 'FS_DENIED' }))).toEqual({
      code: 'FS_DENIED',
      message: 'nope',
    });
  });

  it('非 Error 抛出值 → EXCEPTION,无 message(提示回退 code,不显示 undefined)', () => {
    const f = failureOf('weird');
    expect(f.code).toBe('EXCEPTION');
    expect(f.message).toBeUndefined();
    notifyOpenFailed('a.md', f);
    expect(String(errorSpy.mock.calls[0]?.[0])).not.toContain('undefined');
    expect(failureOf(null).code).toBe('EXCEPTION');
  });
});

describe('接线守卫:三个打开入口共用 openFileOrNotify(ok:false 与 reject 两个分支都提示)', () => {
  it.each([
    'panels/Explorer/FolderTree.tsx',
    'plugins/quick-open/QuickOpenModal.tsx',
    'panels/Editor/EditorPanel.tsx',
  ])('%s', (rel) => {
    const src = readFileSync(path.join(SRC_ROOT, rel), 'utf-8');
    expect(src).toContain('openFileOrNotify(');
    expect(src).not.toContain("t('quick_open.open_failed')");
  });
});

describe('openFileOrNotify', () => {
  it('ok:true → 不提示;ok:false → 按 code 提示;reject → 提示 EXCEPTION', async () => {
    await openFileOrNotify(async () => ({ ok: true as const }), 'a.md');
    expect(errorSpy).not.toHaveBeenCalled();
    await openFileOrNotify(async () => ({ ok: false as const, code: 'FS_EEXIST', message: 'raw' }), 'a.md');
    expect(errorSpy).toHaveBeenLastCalledWith('Failed to open a.md: Already exists', { code: 'FS_EEXIST' });
    await openFileOrNotify(async () => {
      throw new Error('boom');
    }, 'b.md');
    expect(errorSpy.mock.calls.at(-1)?.[1]).toEqual({ code: 'EXCEPTION' });
  });

  it('给 logTag → 自行记 console,toast 关闭 mirror', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await openFileOrNotify(async () => ({ ok: false as const, code: 'FS_EEXIST' }), 'a.md', 'explorer');
    expect(warn).toHaveBeenCalledWith('[explorer] open file failed:', 'FS_EEXIST', undefined);
    expect(errorSpy.mock.calls.at(-1)?.[1]).toEqual({ code: 'FS_EEXIST', mirror: false });
    warn.mockRestore();
  });
});

describe('空 message 不弹空提示(failureOf 与 notifyFailure 共用回退)', () => {
  it('failureOf:空串 message 视同缺省', () => {
    expect(failureOf(Object.assign(new Error(''), { code: 'X_CODE' }))).toEqual({ code: 'X_CODE' });
  });

  it('notifyFailure:未收录 code + 空串 message → 文案回退 code', () => {
    notifyFailure({ code: 'NO_SUCH_CODE_Y', message: '' });
    expect(errorSpy).toHaveBeenCalledWith('NO_SUCH_CODE_Y', { code: 'NO_SUCH_CODE_Y' });
  });

  it('notifyThrownError:非 Error 抛出值 → 文案为 EXCEPTION 的本地化 / code,非空', () => {
    notifyThrownError({ ok: false });
    expect(String(errorSpy.mock.calls[0]?.[0])).not.toBe('');
    expect(errorSpy.mock.calls[0]?.[1]).toEqual({ code: 'EXCEPTION' });
  });
});
