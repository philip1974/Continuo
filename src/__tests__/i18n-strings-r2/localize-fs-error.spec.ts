// @vitest-environment jsdom
// i18n(I6/I7,复查 P1):error toast 入口此前直接展示 main/动作层返回的 raw message
// → 双向泄漏(main 中文→en/ko、main 英文→zh/ko)。localizeErrorByCode 是所有 error 展示
// 入口的单一本地化来源(Explorer FolderTree FS toast、Editor 保存失败 等):按 code 经
// errors.<CODE> catalog 翻译,未收录 code 回退原 message。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { localizeErrorByCode, localizeThrown } from '@/lib/localize-error';
import { setLocale } from '@/i18n';

afterEach(() => setLocale('en'));

describe('localizeErrorByCode(code, message)', () => {
  // 原文缺省 / 空串的回退在本函数内统一做(此前各调用点 `||` / `??` / 不回退三种写法,移动 / 删除失败提示会显示空原因)。
  it('未收录 code + 空串 / 缺省原文 → 回退 code,不显示空原因', () => {
    expect(localizeErrorByCode('NO_SUCH_CODE_Z', '')).toBe('NO_SUCH_CODE_Z');
    expect(localizeErrorByCode('NO_SUCH_CODE_Z')).toBe('NO_SUCH_CODE_Z');
    expect(localizeErrorByCode('NO_SUCH_CODE_Z', 'raw detail')).toBe('raw detail');
  });

  it('catalog 收录的 FS code → 按 locale 本地化(en),不显 raw message', () => {
    setLocale('en');
    // en catalog: errors.FS_EEXIST = 'Already exists'
    expect(localizeErrorByCode('FS_EEXIST', 'already exists')).toBe(
      'Already exists',
    );
  });

  it('catalog 收录的 FS code → zh 显中文(zh/ko 用户不再看到英文 raw)', () => {
    setLocale('zh');
    const r = localizeErrorByCode('FS_EEXIST', 'already exists');
    expect(r).not.toBe('already exists'); // 不泄漏英文 raw
    expect(r.length).toBeGreaterThan(0);
  });

  it('catalog 未收录的 code → 回退原 message(保留动态错误细节)', () => {
    setLocale('zh');
    expect(localizeErrorByCode('SOME_UNKNOWN_CODE', 'weird detail')).toBe(
      'weird detail',
    );
  });

  // 占位符守卫(I8 自身回归防护):errors.FS_NOT_FOUND='File not found: {path}' 含参数,
  // 本 helper 无 params → 不能渲染字面 {path},须退回 raw message(已含真实路径)。
  it('参数化 catalog code(FS_NOT_FOUND 含 {path})→ 退回 raw message,不露字面占位符', () => {
    setLocale('en');
    const raw = 'File not found: /proj/a.ts';
    const r = localizeErrorByCode('FS_NOT_FOUND', raw);
    expect(r).toBe(raw);
    expect(r).not.toContain('{path}'); // 不泄漏字面占位符
  });

  it('占位符检测走字符扫描,不调用 RegExp.test', () => {
    setLocale('en');
    const testSpy = vi.spyOn(RegExp.prototype, 'test');
    try {
      expect(localizeErrorByCode('FS_NOT_FOUND', 'File not found: /x')).toBe(
        'File not found: /x',
      );
      expect(localizeErrorByCode('FS_EEXIST', 'already exists')).toBe(
        'Already exists',
      );
      expect(testSpy).not.toHaveBeenCalled();
    } finally {
      testSpy.mockRestore();
    }
  });

  // I9:Window 命令 WORKSPACE_* code 也带占位符({path}/{workspace}),守卫同样回退 raw。
  it('WORKSPACE_NOT_ABSOLUTE(含 {path})→ 退回 raw,不露字面占位符', () => {
    setLocale('zh');
    const raw = 'Workspace must be an absolute path: foo/bar';
    const r = localizeErrorByCode('WORKSPACE_NOT_ABSOLUTE', raw);
    expect(r).toBe(raw);
    expect(r).not.toContain('{path}');
  });

  // I9:Window 命令的无占位符 code(NO_WINDOW_SEQ)正常本地化。
  it('NO_WINDOW_SEQ(无占位符)→ 正常本地化,zh 不显英文 raw', () => {
    setLocale('zh');
    const r = localizeErrorByCode('NO_WINDOW_SEQ', 'no window seq');
    expect(r).not.toBe('no window seq');
    expect(r.length).toBeGreaterThan(0);
  });
});

describe('localizeThrown(err)', () => {
  it('带 string code 的 Error → 按 catalog 本地化', () => {
    setLocale('en');
    expect(localizeThrown(Object.assign(new Error('already exists'), { code: 'FS_EEXIST' }))).toBe(
      'Already exists',
    );
  });

  it('无 code / code 非 string → 原 message', () => {
    expect(localizeThrown(new Error('boom'))).toBe('boom');
    expect(localizeThrown(Object.assign(new Error('boom'), { code: 42 }))).toBe('boom');
    expect(localizeThrown('raw string')).toBe('raw string');
  });

  it('null / undefined 不抛,回退 String()', () => {
    expect(localizeThrown(null)).toBe('null');
    expect(localizeThrown(undefined)).toBe('undefined');
  });
});
