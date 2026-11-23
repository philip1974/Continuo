// 应用就绪屏障:footer(StatusBar)与 Splash 在 App 的同一次 React 提交中渲染(App.tsx),先等 footer 出现
// 确认 Splash 已挂上,再等 Splash 撤除(布局恢复完成 + 终端首个快照对齐,正常路径下其前提是 root 已恢复)。
// 注意「Splash 撤除 ⇒ root 已恢复」只在正常路径成立:终端就绪的 3s 安全上限(DOCK_TERMINAL_READY_TIMEOUT_MS)、
// listSessions 失败时的 markSettled、windowId 非有限值时的 markHydrated 都会在 rootRestored 之前放行 Splash。
// 直接在 domcontentloaded 后断言 Splash 数量为 0 是恒真的:此时 main-app 尚未 render,Splash 还不存在。
import { expect, type Page } from '@playwright/test';

export async function waitForAppReady(page: Page): Promise<void> {
  await expect(page.locator('footer')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('splash')).toHaveCount(0, { timeout: 15_000 });
}
