// 主进程兜底:页面试图把应用窗口导航到外部 URL 时被拦下(应用界面不被网页顶替)。
// renderer 侧的链接点击处理是第一道,这里绕过它直接验证 will-navigate 守卫。
import { test, expect } from './fixtures/with-workspace';

test('页面内 <a href> 指向应用外的默认导航被主进程拦下', async ({ window, electronApp }) => {
  await expect(window.locator('main')).toBeVisible({ timeout: 10_000 });
  const appUrl = window.url();

  await window.evaluate(() => {
    const a = document.createElement('a');
    // file: 不在外链白名单里 → 只验证「拦下」,不会真的拉起系统浏览器
    a.href = 'file:///tmp/continuo-nav-guard-away.html';
    a.textContent = 'away';
    a.id = 'nav-guard-probe';
    document.body.appendChild(a);
    a.click();
  });
  await window.waitForTimeout(1_000);

  // 被拦下的导航之后 Playwright 的 locator 会一直等「导航结束」,所以直接在页面里取证:
  // 文档还是应用自己的(探针节点仍在),地址没变。
  expect(window.url()).toBe(appUrl);
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(
        "location.href + '|' + Boolean(document.getElementById('nav-guard-probe'))",
      ),
    ),
  ).toBe(`${appUrl}|true`);
});

// dev 与打包版同一套规则:页面发起的导航即便指回本应用入口(location.reload() / 带启动参数的入口 URL)
// 也拦下 —— 否则页面内容能以任意 workspace / fresh 重开当前窗口。窗口刷新只走 main 侧(View → Reload)。
test('页面发起的、指回本应用入口的导航(location.reload / 带启动参数)同样被拦下', async ({ window, electronApp }) => {
  await expect(window.locator('main')).toBeVisible({ timeout: 10_000 });
  const appUrl = window.url();

  await window.evaluate((url) => {
    const marker = document.createElement('div');
    marker.id = 'nav-guard-reload-probe';
    document.body.appendChild(marker);
    const target = new URL(url);
    target.search = '?workspace=%2F&fresh=1&windowSeq=0';
    setTimeout(() => location.reload(), 0);
    setTimeout(() => {
      location.href = target.toString();
    }, 50);
  }, appUrl);
  await window.waitForTimeout(1_000);

  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(
        "location.href + '|' + Boolean(document.getElementById('nav-guard-reload-probe'))",
      ),
    ),
  ).toBe(`${appUrl}|true`);
});
