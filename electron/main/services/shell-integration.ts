import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export type SupportedShell = 'zsh' | 'bash' | 'fish' | null;

const ZSH_SNIPPET = String.raw`[ -f "$_CONTINUO_USER_ZDOTDIR/.zshrc" ] && source "$_CONTINUO_USER_ZDOTDIR/.zshrc"

_continuo_osc7() {
  printf '\e]7;file://%s%s\a' "${'${HOST:-}'}" "$PWD"
}

typeset -ag chpwd_functions
chpwd_functions+=(_continuo_osc7)
_continuo_osc7
`;

const BASH_SNIPPET = String.raw`[ -n "$_CONTINUO_USER_BASH_RC" ] && [ -f "$_CONTINUO_USER_BASH_RC" ] && source "$_CONTINUO_USER_BASH_RC"

_continuo_osc7() {
  printf '\e]7;file://%s%s\a' "${'${HOSTNAME:-}'}" "$PWD"
}

if [ -n "${'${PROMPT_COMMAND:-}'}" ]; then
  PROMPT_COMMAND="_continuo_osc7; ${'${PROMPT_COMMAND}'}"
else
  PROMPT_COMMAND="_continuo_osc7"
fi

_continuo_osc7
`;

const FISH_SNIPPET = String.raw`if test -n "$_CONTINUO_USER_FISH_CONFIG"; and test -f "$_CONTINUO_USER_FISH_CONFIG"
  source "$_CONTINUO_USER_FISH_CONFIG"
end

function _continuo_osc7 --on-variable PWD
  printf '\e]7;file://%s%s\a' (hostname) "$PWD"
end

_continuo_osc7
`;

export function detectShell(shellPath?: string): SupportedShell {
  if (!shellPath) return null;
  const name = path.basename(shellPath);
  if (name === 'zsh') return 'zsh';
  if (name === 'bash') return 'bash';
  if (name === 'fish') return 'fish';
  return null;
}

async function noopCleanup(): Promise<void> {}

export async function prepareEnv(
  shellPath: string,
  baseEnv: NodeJS.ProcessEnv,
): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const shell = detectShell(shellPath);
  if (!shell) return { env: baseEnv, cleanup: noopCleanup };

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'continuo-shell-'));
  const cleanup = async (): Promise<void> => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  };

  if (shell === 'zsh') {
    await fs.writeFile(path.join(tmpDir, '.zshrc'), ZSH_SNIPPET, 'utf8');
    return {
      env: {
        ...baseEnv,
        ZDOTDIR: tmpDir,
        _CONTINUO_USER_ZDOTDIR: baseEnv.ZDOTDIR ?? baseEnv.HOME ?? '',
      },
      cleanup,
    };
  }

  if (shell === 'bash') {
    const rcfile = path.join(tmpDir, '.bashrc');
    await fs.writeFile(rcfile, BASH_SNIPPET, 'utf8');
    return {
      env: {
        ...baseEnv,
        BASH_ENV: rcfile,
        ENV: rcfile,
        _CONTINUO_USER_BASH_RC: baseEnv.HOME
          ? path.join(baseEnv.HOME, '.bashrc')
          : '',
      },
      cleanup,
    };
  }

  const confDir = path.join(tmpDir, 'fish', 'conf.d');
  await fs.mkdir(confDir, { recursive: true });
  await fs.writeFile(path.join(confDir, '_continuo.fish'), FISH_SNIPPET, 'utf8');
  return {
    env: {
      ...baseEnv,
      XDG_CONFIG_HOME: tmpDir,
      _CONTINUO_USER_FISH_CONFIG: baseEnv.XDG_CONFIG_HOME
        ? path.join(baseEnv.XDG_CONFIG_HOME, 'fish', 'config.fish')
        : baseEnv.HOME
          ? path.join(baseEnv.HOME, '.config', 'fish', 'config.fish')
          : '',
    },
    cleanup,
  };
}
