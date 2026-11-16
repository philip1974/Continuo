import { describe, expect, it, vi } from 'vitest';
import { withPtyLangEnv } from '../../../electron/main/services/pty-lang';

describe('PTY LANG safeguard', () => {
  it('env.LANG=ja_JP.UTF-8 被保留（用户偏好不被覆盖）', async () => {
    const env = withPtyLangEnv({ LANG: 'ja_JP.UTF-8', PATH: '/x' }, 'ko');

    expect(env.LANG).toBe('ja_JP.UTF-8');
    expect(env.PATH).toBe('/x');
  });

  it('UTF-8 LANG 判断走字符扫描,不调用 RegExp.test', async () => {
    const testSpy = vi.spyOn(RegExp.prototype, 'test');
    try {
      expect(withPtyLangEnv({ LANG: 'ja_JP.utf8' }, 'ko').LANG).toBe(
        'ja_JP.utf8',
      );
      expect(withPtyLangEnv({ LANG: 'ja-JP.UTF-8' }, 'ko').LANG).toBe(
        'ko_KR.UTF-8',
      );
      expect(testSpy).not.toHaveBeenCalled();
    } finally {
      testSpy.mockRestore();
    }
  });

  it('env.LANG=zh_CN.GBK 被替换为 LANG_MAP[currentLocale]', async () => {
    const env = withPtyLangEnv({ LANG: 'zh_CN.GBK', PATH: '/x' }, 'ko');

    expect(env.LANG).toBe('ko_KR.UTF-8');
    expect(env.LC_ALL).toBe('ko_KR.UTF-8');
    expect(env.PATH).toBe('/x');
  });

  it('env.LANG 缺失时填 LANG_MAP[currentLocale]', async () => {
    const env = withPtyLangEnv({ PATH: '/x' }, 'zh');

    expect(env.LANG).toBe('zh_CN.UTF-8');
    expect(env.LC_ALL).toBe('zh_CN.UTF-8');
    expect(env.PATH).toBe('/x');
  });

  // 有效 locale 按 POSIX 优先级 LC_ALL > LC_CTYPE > LANG 取(空串视同未设)。
  // 旧实现只看 LANG:LANG=ja_JP.UTF-8 + LC_ALL=C 时有效字符集仍是 C,却被当成 UTF-8 放行。
  it('LANG 是 UTF-8 但 LC_ALL=C → 有效 locale 非 UTF-8,按覆盖策略替换', async () => {
    const env = withPtyLangEnv({ LANG: 'ja_JP.UTF-8', LC_ALL: 'C' }, 'ko');

    expect(env.LANG).toBe('ko_KR.UTF-8');
    expect(env.LC_ALL).toBe('ko_KR.UTF-8');
  });

  it('LC_ALL 未设、LC_CTYPE=C 覆盖 UTF-8 LANG → 按覆盖策略替换', async () => {
    const env = withPtyLangEnv({ LANG: 'ja_JP.UTF-8', LC_CTYPE: 'C' }, 'zh');

    expect(env.LC_ALL).toBe('zh_CN.UTF-8');
  });

  it('LC_ALL 是 UTF-8(即使 LANG 非 UTF-8)→ 原样保留', async () => {
    const input = { LANG: 'C', LC_ALL: 'ja_JP.UTF-8' };
    expect(withPtyLangEnv(input, 'ko')).toBe(input);
  });

  it('空串 LC_ALL 视同未设,回落到 LANG 判断', async () => {
    const input = { LANG: 'ja_JP.UTF-8', LC_ALL: '' };
    expect(withPtyLangEnv(input, 'ko')).toBe(input);
  });
});
