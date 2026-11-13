import { app } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const DEBUG_ADAPTER_RELATIVE_PATH = path.join(
  'js-debug',
  'src',
  'dapDebugServer.js',
);

function sourceTreeAdapterPath(): string {
  return path.join(
    process.cwd(),
    'scripts',
    'debug-spike',
    '.adapter',
    DEBUG_ADAPTER_RELATIVE_PATH,
  );
}

function packagedAdapterCandidates(): string[] {
  const resourcesPath = process.resourcesPath;
  const appPath = app.getAppPath();
  // asar 打包时 asarUnpack 的文件落在 `<app>.asar.unpacked/`。
  const unpackedAppPath = `${appPath}.unpacked`;

  return [
    path.join(resourcesPath, DEBUG_ADAPTER_RELATIVE_PATH),
    path.join(
      unpackedAppPath,
      'scripts',
      'debug-spike',
      '.adapter',
      DEBUG_ADAPTER_RELATIVE_PATH,
    ),
  ];
}

export function getDebugAdapterCandidates(): readonly string[] {
  if (!app.isPackaged) return [sourceTreeAdapterPath()];
  return packagedAdapterCandidates();
}

export function resolveDebugAdapterPath(): string {
  const candidates = getDebugAdapterCandidates();
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}
