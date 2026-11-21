// paste 三次 → README.md / README copy.md / README copy 2.md.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

const COPY = /^(复制|Copy|복사)$/;
const PASTE = /^(粘贴|Paste|붙여넣기)$/;

test('copy + paste×3 → 三种命名', async ({ window, workspaceRoot }) => {
  await window.locator('text=README.md').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: COPY }).click();
  await window.locator('text=src').first().click();

  for (let i = 0; i < 3; i++) {
    await window.locator('text=src').first().click({ button: 'right' });
    await window.getByRole('menuitem', { name: PASTE }).click();
    await window.waitForTimeout(200);
  }

  await expect(async () => {
    const f1 = await stat(path.join(workspaceRoot, 'src/README.md'))
      .then(() => true)
      .catch(() => false);
    const f2 = await stat(path.join(workspaceRoot, 'src/README copy.md'))
      .then(() => true)
      .catch(() => false);
    const f3 = await stat(path.join(workspaceRoot, 'src/README copy 2.md'))
      .then(() => true)
      .catch(() => false);
    expect(f1).toBe(true);
    expect(f2).toBe(true);
    expect(f3).toBe(true);
  }).toPass({ timeout: 5_000 });
});
