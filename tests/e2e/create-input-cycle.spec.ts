// 新建文件 input ESC 关 + 重开循环不抛.
import { test, expect } from './fixtures/with-workspace';

const NEW_FILE = /^(新建文件|New file|새 파일)$/;
const NEW_FILE_NAME = /^(新建文件名…|New file name…|새 파일 이름…)$/;

test('header 新建文件 → ESC → 重开 → input 再现', async ({ window }) => {
  const aside = window.locator('main aside').nth(1);
  const newFileBtn = aside.getByRole('button', { name: NEW_FILE });

  for (let i = 0; i < 3; i++) {
    await aside.locator('div.group').first().hover();
    await newFileBtn.click();
    const input = window.getByRole('textbox', { name: NEW_FILE_NAME });
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.press('Escape');
    await expect(input).toBeHidden({ timeout: 3_000 });
  }
});
