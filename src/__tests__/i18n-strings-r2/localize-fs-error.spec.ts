// @vitest-environment jsdom
// i18n(I6/I7,codex 复查 P1):error toast 入口此前直接展示 main/动作层返回的 raw message
// → 双向泄漏(main 中文→en/ko、main 英文→zh/ko)。localizeErrorByCode 是所有 error 展示
// 入口的单一本地化来源(Explorer FolderTree FS toast、Editor 保存失败 等):按 code 经
// errors.<CODE> catalog 翻译,未收录 code 回退原 message。

import { describe, it, expect, afterEach } from 'vitest';
import { localizeErrorByCode } from '@/lib/localize-error';
import { setLocale } from '@/i18n';

afterEach(() => setLocale('en'));

describe('localizeErrorByCode(code, message)', () => {
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

  // I7:Editor 保存失败的 UNSAVED_DRAFT message 含中文,直接展示双向泄漏 → 改 catalog。
  it('UNSAVED_DRAFT(原 message 含中文)→ en 显英文 catalog,不泄漏中文', () => {
    setLocale('en');
    const r = localizeErrorByCode(
      'UNSAVED_DRAFT',
      'untitled draft cannot save without a path (MVP 不支持另存为)',
    );
    expect(r).toBe('Untitled draft cannot be saved without a path');
    expect(r).not.toContain('不支持'); // 不泄漏中文 fallback
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
