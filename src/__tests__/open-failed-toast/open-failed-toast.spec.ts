// BDD:打开文件失败的统一提示。见同目录 README。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { errorSpy } = vi.hoisted(() => ({ errorSpy: vi.fn() }));
vi.mock('../../notifications/notify', () => ({ notify: { error: errorSpy } }));

import { notifyOpenFailed, openFailureOf } from '../../notifications/notify-open-failed';
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

describe('openFailureOf(抛出值 → 失败描述)', () => {
  it('带 code 的 Error → 该 code + message', () => {
    expect(openFailureOf(Object.assign(new Error('nope'), { code: 'FS_DENIED' }))).toEqual({
      code: 'FS_DENIED',
      message: 'nope',
    });
  });

  it('非 Error 抛出值 → EXCEPTION,无 message(提示回退 code,不显示 undefined)', () => {
    const f = openFailureOf('weird');
    expect(f.code).toBe('EXCEPTION');
    expect(f.message).toBeUndefined();
    notifyOpenFailed('a.md', f);
    expect(String(errorSpy.mock.calls[0]?.[0])).not.toContain('undefined');
    expect(openFailureOf(null).code).toBe('EXCEPTION');
  });
});

describe('接线守卫:两个打开入口共用 notifyOpenFailed', () => {
  it.each(['panels/Explorer/FolderTree.tsx', 'plugins/quick-open/QuickOpenModal.tsx'])('%s', (rel) => {
    const src = readFileSync(path.join(SRC_ROOT, rel), 'utf-8');
    expect(src).toContain('notifyOpenFailed(');
    expect(src).not.toContain("t('quick_open.open_failed')");
  });
});
