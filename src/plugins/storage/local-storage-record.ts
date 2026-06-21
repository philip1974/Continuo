// 可维护性 M21:localStorage 上「string→V 对象」全局配置的持久化 + 跨窗同步样板单一来源。
//
// settings values-store 与 keybindings overrides-store 此前各自手写同一套:从 localStorage
// 读 JSON object(容错 SSR/无 localStorage/解析失败/非对象)、写 JSON object(吞 quota/disabled)、
// 监听 `storage` 事件按 key 重读。抽成 helper,各 store 只保留自己的 key / 值类型 / setState 映射。

/** 读 localStorage[key] 的 JSON 对象;无/非对象/解析失败/无 localStorage → {}. */
export function readRecord<V>(key: string): Record<string, V> {
  if (typeof globalThis.localStorage === 'undefined') return {};
  try {
    const raw = globalThis.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, V>)
      : {};
  } catch {
    return {};
  }
}

/** 写 localStorage[key];quota / disabled / 无 localStorage 静默忽略(内存态仍在). */
export function writeRecord<V>(key: string, value: Record<string, V>): void {
  if (typeof globalThis.localStorage === 'undefined') return;
  try {
    globalThis.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // quota / disabled — 静默
  }
}

/**
 * 监听别的同源 document 对 localStorage[key] 的修改(跨窗口同步)。`storage` 事件仅在
 * **其它** document 改 localStorage 时 fire,故同窗自己的写不会回环。调用方在 onChange 里
 * 重读并 setState,让各窗口收敛一致。无 window / SSR 时 no-op。
 */
export function subscribeStorageKey(key: string, onChange: () => void): void {
  if (
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function'
  ) {
    return;
  }
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key !== key) return;
    onChange();
  });
}
