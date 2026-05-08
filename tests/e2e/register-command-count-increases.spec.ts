// 动态 registerCommand → commandCount 增加 + dispose 后回落.
import { test, expect } from './fixtures/electron-app';

test('registerCommand → count + 1; dispose → count -1', async ({
  window,
}) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // initial count
  const initial = await window.evaluate(
    () =>
      (
        window as unknown as {
          __continuoTest: { commandCount: () => number };
        }
      ).__continuoTest.commandCount(),
  );

  // register 3 命令,记下 dispose
  const disposed = await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          registerCommand: (id: string, title: string) => () => void;
          commandCount: () => number;
        };
      }
    ).__continuoTest;
    const d1 = t.registerCommand('e2e.a', 'A');
    const d2 = t.registerCommand('e2e.b', 'B');
    const d3 = t.registerCommand('e2e.c', 'C');
    const after = t.commandCount();
    // dispose 第 1 个
    d1();
    const afterDispose = t.commandCount();
    // 回归原数(剩余 dispose)
    d2();
    d3();
    return { after, afterDispose, final: t.commandCount() };
  });

  expect(disposed.after).toBe(initial + 3);
  expect(disposed.afterDispose).toBe(initial + 2);
  expect(disposed.final).toBe(initial);
});
