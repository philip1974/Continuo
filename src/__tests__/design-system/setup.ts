// jsdom 不内置 matchMedia,polyfill 给 ThemeProvider 用。
// 默认 dark(等价于系统偏好暗色),手动测试时可重写 .matches。
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      matches: query.includes('dark'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// Node 25 exposes an experimental global localStorage when launched without a
// valid --localstorage-file. In Vitest jsdom that can shadow jsdom's Storage and
// lacks clear(), breaking specs that rely on browser Storage semantics. Keep
// localStorage/sessionStorage on the same Storage prototype so prototype spies
// in specs keep observing instance calls.
if (
  typeof window !== 'undefined' &&
  typeof globalThis.localStorage !== 'undefined' &&
  typeof globalThis.localStorage.clear !== 'function'
) {
  class MemoryStorage implements Storage {
    private readonly data = new Map<string, string>();

    get length(): number {
      return this.data.size;
    }

    clear(): void {
      this.data.clear();
    }

    getItem(key: string): string | null {
      return this.data.get(String(key)) ?? null;
    }

    key(index: number): string | null {
      return Array.from(this.data.keys())[index] ?? null;
    }

    removeItem(key: string): void {
      this.data.delete(String(key));
    }

    setItem(key: string, value: string): void {
      this.data.set(String(key), String(value));
    }
  }

  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  Object.defineProperty(globalThis, 'Storage', {
    configurable: true,
    value: MemoryStorage,
  });
  Object.defineProperty(window, 'Storage', {
    configurable: true,
    value: MemoryStorage,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: localStorage,
  });
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: localStorage,
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: sessionStorage,
  });
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    value: sessionStorage,
  });
}

// topic-19: sibling spec 中的 hardcode 中文 assert（'确认' / '新建文件' 等）
// 假定 UI 用中文 — 之前 hardcode 字面量为中文。本 topic 把它们都改成 t() / useT()，
// 默认 locale='en' 会返英文，全套 sibling spec 会 break。
// 把测试环境默认 locale 设为 zh，保留这些 spec 的语义（"中文 UI 显示中文文案"）。
// 单独需要切其他 locale 的 spec 内部 setLocale('en'|'ko') 覆盖。
import { setLocale } from '@/i18n/translate';
setLocale('zh');
