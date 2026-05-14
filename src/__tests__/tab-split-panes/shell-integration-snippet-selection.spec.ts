import { afterEach, describe, expect, it, vi } from 'vitest';

describe('tab split panes - shell integration snippet selection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('selects zsh, bash, and fish snippets from SHELL and degrades with no injection for unknown shells', async () => {
    const service = (await import('../../../electron/main/services/shell-integration')) as {
      detectShell?: (shellPath: string | undefined) => string | null;
      prepareEnv?: (
        shellPath: string,
        baseEnv: NodeJS.ProcessEnv,
      ) => Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }>;
    };

    expect(service.detectShell?.('/bin/zsh')).toBe('zsh');
    expect(service.detectShell?.('/bin/bash')).toBe('bash');
    expect(service.detectShell?.('/usr/local/bin/fish')).toBe('fish');
    expect(service.detectShell?.('/opt/bin/nu')).toBeNull();

    const zsh = await service.prepareEnv?.('/bin/zsh', { SHELL: '/bin/zsh' });
    const bash = await service.prepareEnv?.('/bin/bash', { SHELL: '/bin/bash' });
    const fish = await service.prepareEnv?.('/usr/local/bin/fish', { SHELL: '/usr/local/bin/fish' });
    const unknown = await service.prepareEnv?.('/opt/bin/nu', { SHELL: '/opt/bin/nu' });

    // zsh path 现在 noop (不 hijack ZDOTDIR — 让 oh-my-zsh/plugin 在原生
    // 环境跑;OSC 7 自动跟踪 disabled 直到换 main-side cwd 探测方案):
    expect(zsh?.env).toEqual({ SHELL: '/bin/zsh' });
    expect(bash?.env).toEqual(expect.objectContaining({ SHELL: '/bin/bash', BASH_ENV: expect.any(String) }));
    expect(fish?.env).toEqual(expect.objectContaining({ SHELL: '/usr/local/bin/fish', XDG_CONFIG_HOME: expect.any(String) }));
    expect(unknown?.env).toEqual({ SHELL: '/opt/bin/nu' });
  });
});
