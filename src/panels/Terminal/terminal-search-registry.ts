const searchFns = new Map<string, () => void>();

export function registerTerminalSearch(
  panelId: string,
  openFn: () => void,
): { dispose: () => void } {
  searchFns.set(panelId, openFn);
  return {
    dispose: () => {
      searchFns.delete(panelId);
    },
  };
}

export function openTerminalSearch(panelId: string): boolean {
  const openFn = searchFns.get(panelId);
  if (!openFn) return false;
  openFn();
  return true;
}

export function unregisterTerminalSearch(panelId: string): void {
  searchFns.delete(panelId);
}

export function __resetTerminalSearchRegistryForTest(): void {
  searchFns.clear();
}
