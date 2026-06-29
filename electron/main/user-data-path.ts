import path from 'node:path';

export interface UserDataPathOptions {
  readonly appDataPath: string;
  readonly e2eUserDataDir: string;
  readonly isDev: boolean;
  readonly isE2E: boolean;
}

export function resolveUserDataPath({
  appDataPath,
  e2eUserDataDir,
  isDev,
  isE2E,
}: UserDataPathOptions): string | null {
  if (isE2E && e2eUserDataDir.trim() !== '') {
    return e2eUserDataDir;
  }

  if (isDev) {
    return path.join(appDataPath, 'Continuo Dev');
  }

  return null;
}
