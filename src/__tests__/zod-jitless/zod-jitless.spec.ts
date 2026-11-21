import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import '@/lib/zod-jitless';

describe('renderer zod jitless', () => {
  it('导入后 zod 全局配置 jitless = true', () => {
    expect(z.config().jitless).toBe(true);
  });

  it('main-app.ts 的第一个 import 是 ./lib/zod-jitless', () => {
    const src = readFileSync(join(__dirname, '../../main-app.ts'), 'utf8');
    const firstImport = src.split(/\r?\n/).find((l) => l.startsWith('import '));
    expect(firstImport).toBe("import './lib/zod-jitless';");
  });
});
