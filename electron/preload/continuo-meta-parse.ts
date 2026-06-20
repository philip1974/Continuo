// topic 48: preload-side pure helper for `--continuo-packaged=<bool>`.
export function parseContinuoPackagedFromArgv(
  argv: readonly string[],
): boolean | null {
  const arg = argv.find((a) => a.startsWith('--continuo-packaged='));
  if (arg === '--continuo-packaged=true') return true;
  if (arg === '--continuo-packaged=false') return false;
  return null;
}
