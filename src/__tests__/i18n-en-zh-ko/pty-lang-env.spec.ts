import { describe, expect, it } from 'vitest';
import { withPtyLangEnv } from '../../../electron/main/services/pty-lang';

describe('PTY LANG safeguard', () => {
  it('env.LANG=ja_JP.UTF-8 被保留（用户偏好不被覆盖）', async () => {
    const env = withPtyLangEnv({ LANG: 'ja_JP.UTF-8', PATH: '/x' }, 'ko');

    expect(env.LANG).toBe('ja_JP.UTF-8');
    expect(env.PATH).toBe('/x');
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
