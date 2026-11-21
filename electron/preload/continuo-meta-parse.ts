// topic 48: preload-side pure helper for `--continuo-packaged=<bool>`.
export function parseContinuoPackagedFromArgv(
  argv: readonly string[],
): boolean | null {
  const arg = argv.find((a) => a.startsWith('--continuo-packaged='));
  if (arg === '--continuo-packaged=true') return true;
  if (arg === '--continuo-packaged=false') return false;
  return null;
}

// OSC7 acceptedHosts:解析 main 注入的 `--continuo-hostname=<host>`;缺失 / 空 → null。
export function parseContinuoHostnameFromArgv(
  argv: readonly string[],
): string | null {
  const prefix = '--continuo-hostname=';
  const arg = argv.find((a) => a.startsWith(prefix));
  const host = arg?.slice(prefix.length);
  return host ? host : null;
}

// 终端 xterm windowsPty:解析 main 注入的 `--continuo-windows-build=<n>`(仅 win32 注入);缺失 / 非法 → null。
export function parseContinuoWindowsBuildFromArgv(
  argv: readonly string[],
): number | null {
  const prefix = '--continuo-windows-build=';
  const value = argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}
