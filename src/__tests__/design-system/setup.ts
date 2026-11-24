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

// jsdom 不内置 IntersectionObserver。@milkdown/components ≥7.21 的代码块在进入视口时才创建
// CodeMirror(离屏时显示纯文本占位),构造时即 observe。jsdom 无布局,按「全部可见」处理:
// observe 后异步(同真实浏览器的首次回调)报告 isIntersecting=true。
if (typeof window !== 'undefined' && typeof window.IntersectionObserver !== 'function') {
  class VisibleIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '0px';
    readonly thresholds = [0];
    private readonly targets = new Set<Element>();
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element): void {
      this.targets.add(target);
      queueMicrotask(() => {
        if (!this.targets.has(target)) return;
        const rect = target.getBoundingClientRect();
        this.callback(
          [
            {
              target,
              isIntersecting: true,
              intersectionRatio: 1,
              boundingClientRect: rect,
              intersectionRect: rect,
              rootBounds: null,
              time: Date.now(),
            },
          ],
          this,
        );
      });
    }
    unobserve(target: Element): void {
      this.targets.delete(target);
    }
    disconnect(): void {
      this.targets.clear();
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: VisibleIntersectionObserver });
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: VisibleIntersectionObserver });
}

// Node 25 exposes an experimental global localStorage when launched without a
// valid --localstorage-file. Touching that getter in Vitest jsdom emits a
// warning and returns a non-browser-shaped object. Detect via descriptor so we
// can install deterministic Storage before specs import stores that read it.
const globalLocalStorageDescriptor =
  typeof window === 'undefined'
    ? undefined
    : Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const globalLocalStorageValue =
  globalLocalStorageDescriptor && 'value' in globalLocalStorageDescriptor
    ? globalLocalStorageDescriptor.value
    : undefined;

if (
  typeof window !== 'undefined' &&
  typeof globalLocalStorageValue?.clear !== 'function'
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
