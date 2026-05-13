import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('tab split panes - before-quit per-window flush', () => {
  it('main before-quit uses per-window ack, timeout, and flushDone guard', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'electron/main/index.ts'),
      'utf8',
    );

    expect(source).toContain('let flushDone = false');
    expect(source).toContain("app.on('before-quit', async");
    expect(source).toContain("ipcMain.on('layout:flush-ack'");
    expect(source).toContain("w.webContents.send('layout:flush-request')");
    expect(source).toContain('setTimeout(resolve, 1500)');
    expect(source).toContain('app.quit()');
  });
});
