// page.evaluate / waitForFunction 回调在 renderer 里执行:让其中的 `globalThis.__continuoTest` 直接带上
// renderer 侧的真实钩子类型(src/continuo-test-hooks),用例不再各自 `as unknown as { … }` 重写签名。
// 用 globalThis 而非 window:多数用例的 Playwright Page 参数就叫 `window`,会在回调里遮蔽浏览器全局。
import type { ContinuoTestHooks } from '../../src/continuo-test-hooks';

declare global {
  // 全局变量声明须用 var 才会成为 globalThis 上的属性。
  var __continuoTest: ContinuoTestHooks | undefined;
}

export {};
