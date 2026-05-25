function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform);
}

export function isSearchHotkey(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== 'f') return false;
  if (event.altKey || event.shiftKey) return false;
  if (isMacPlatform()) {
    return event.metaKey && !event.ctrlKey;
  }
  return event.ctrlKey && !event.metaKey;
}
