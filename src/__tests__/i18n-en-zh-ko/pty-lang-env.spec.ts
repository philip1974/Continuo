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
});
