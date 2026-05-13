import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export type SupportedShell = 'zsh' | 'bash' | 'fish' | null;

const SERVICE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SNIPPETS_DIR = path.join(SERVICE_DIR, 'shell-integration-snippets');

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
    const snippet = await fs.readFile(
      path.join(SNIPPETS_DIR, 'zsh.sh'),
      'utf8',
    );
    await fs.writeFile(path.join(tmpDir, '.zshrc'), snippet, 'utf8');
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
    const snippet = await fs.readFile(
      path.join(SNIPPETS_DIR, 'bash.sh'),
      'utf8',
    );
    const rcfile = path.join(tmpDir, '.bashrc');
    await fs.writeFile(rcfile, snippet, 'utf8');
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

  const snippet = await fs.readFile(
    path.join(SNIPPETS_DIR, 'fish.fish'),
    'utf8',
  );
  const confDir = path.join(tmpDir, 'fish', 'conf.d');
  await fs.mkdir(confDir, { recursive: true });
  await fs.writeFile(path.join(confDir, '_continuo.fish'), snippet, 'utf8');
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
