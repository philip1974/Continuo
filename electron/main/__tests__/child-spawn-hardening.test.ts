// 安全:插件子进程 spawn 前的兜底(git 命令行作用域配置)。
import { describe, expect, it } from 'vitest';
import { withGitHardeningEnv } from '../lib/child-spawn-hardening';

describe('withGitHardeningEnv', () => {
  it('无既有 GIT_CONFIG_COUNT 时注入 core.fsmonitor=false,且不改入参', () => {
    const src = { PATH: '/usr/bin' };
    const out = withGitHardeningEnv(src);
    expect(out).toMatchObject({
      PATH: '/usr/bin',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'false',
    });
    expect(src).toEqual({ PATH: '/usr/bin' });
  });

  it('调用方已带 GIT_CONFIG_COUNT 时从其后追加,不覆盖既有条目', () => {
    const out = withGitHardeningEnv({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'a.b',
      GIT_CONFIG_VALUE_0: '1',
      GIT_CONFIG_KEY_1: 'core.fsmonitor',
      GIT_CONFIG_VALUE_1: 'evil',
    });
    expect(out).toMatchObject({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'a.b',
      GIT_CONFIG_VALUE_0: '1',
      GIT_CONFIG_KEY_2: 'core.fsmonitor',
      GIT_CONFIG_VALUE_2: 'false',
    });
  });
});
