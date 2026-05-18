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

// topic-19: sibling spec 中的 hardcode 中文 assert（'确认' / '新建文件' 等）
// 假定 UI 用中文 — 之前 hardcode 字面量为中文。本 topic 把它们都改成 t() / useT()，
// 默认 locale='en' 会返英文，全套 sibling spec 会 break。
// 把测试环境默认 locale 设为 zh，保留这些 spec 的语义（"中文 UI 显示中文文案"）。
// 单独需要切其他 locale 的 spec 内部 setLocale('en'|'ko') 覆盖。
import { setLocale } from '@/i18n/translate';
setLocale('zh');
