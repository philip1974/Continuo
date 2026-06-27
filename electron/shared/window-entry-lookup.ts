export function findWindowEntryBySeq<T extends { readonly windowSeq: number }>(
  windows: readonly T[],
  seq: number,
): T | null {
  for (const windowEntry of windows) {
    if (windowEntry.windowSeq === seq) return windowEntry;
  }
  return null;
}
