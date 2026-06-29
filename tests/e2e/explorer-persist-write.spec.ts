// 改 store(切 sidebar)→ debounce 300ms → explorer.json 写盘 + 内容验证.
import { expect, test } from './fixtures/with-workspace';
import { EXPLORER_HIDE } from './helpers/explorer';
import { readFileSync } from 'node:fs';
import path from 'node:path';

test('关 sidebar → 等 debounce → explorer.json layoutUi.sidebarOpen=false', async ({
  userDataDir,
  window,
}) => {
  // 关 sidebar(默认 open)
  await window.getByRole('button', { name: EXPLORER_HIDE }).click();
  // 等 debounce 300ms + IPC 写
  await window.waitForTimeout(800);

  // 读磁盘 explorer.json
  const raw = readFileSync(path.join(userDataDir, 'explorer.json'), 'utf8');
  const data = JSON.parse(raw) as {
    windows?: Array<{ layoutUi?: { sidebarOpen?: boolean } }>;
  };
  expect(data.windows?.[0]?.layoutUi?.sidebarOpen).toBe(false);
});
