import { afterEach, describe, expect, it, vi } from 'vitest';

type Locale = 'en' | 'zh' | 'ko';
type PtyLangModule = {
  readonly LANG_MAP: Readonly<Record<Locale, string>>;
  readonly withPtyLangEnv: (
    env: Readonly<Record<string, string>>,
  ) => Readonly<Record<string, string>>;
};

const i18nMainMock = vi.hoisted(() => ({
  getCurrentLocale: vi.fn<() => Locale>(() => 'ko'),
}));

vi.mock('../../../electron/main/i18n-main', () => i18nMainMock);

async function importPending<T>(moduleId: string): Promise<T> {
  return (await import(moduleId)) as T;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('PTY LANG safeguard', () => {
  it('env.LANG=ja_JP.UTF-8 被保留（用户偏好不被覆盖）', async () => {
    const { withPtyLangEnv } = await importPending<PtyLangModule>(
      '../../../electron/main/services/pty-lang',
    );

    expect(withPtyLangEnv({ LANG: 'ja_JP.UTF-8' }).LANG).toBe(
      'ja_JP.UTF-8',
    );
  });

  it('env.LANG=zh_CN.GBK 被替换为 LANG_MAP[currentLocale]', async () => {
    const { LANG_MAP, withPtyLangEnv } = await importPending<PtyLangModule>(
      '../../../electron/main/services/pty-lang',
    );

    expect(withPtyLangEnv({ LANG: 'zh_CN.GBK' }).LANG).toBe(LANG_MAP.ko);
  });

  it('env.LANG 缺失时填 LANG_MAP[currentLocale]', async () => {
    const { withPtyLangEnv } = await importPending<PtyLangModule>(
      '../../../electron/main/services/pty-lang',
    );

    expect(withPtyLangEnv({ PATH: '/usr/bin' }).LANG).toBe('ko_KR.UTF-8');
  });
});
