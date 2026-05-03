import { describe, it, expect } from 'vitest';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');

describe('第三方引用清单', () => {
  it('LICENSE-3RD-PARTY.md 存在', async () => {
    await expect(access(path.join(ROOT, 'LICENSE-3RD-PARTY.md'))).resolves.toBeUndefined();
  });

  it('包含 Aceternity UI 引用与 MIT 标注', async () => {
    const raw = await readFile(path.join(ROOT, 'LICENSE-3RD-PARTY.md'), 'utf-8');
    expect(raw).toMatch(/Aceternity/i);
    expect(raw).toMatch(/MIT/);
  });

  it('Spotlight 与 BackgroundBeams 源文件头部都标注了 source URL', async () => {
    const spotlight = await readFile(
      path.join(ROOT, 'src/shell/decor/Spotlight.tsx'),
      'utf-8',
    );
    const beams = await readFile(
      path.join(ROOT, 'src/shell/decor/BackgroundBeams.tsx'),
      'utf-8',
    );
    expect(spotlight).toMatch(/Source: https:\/\/ui\.aceternity\.com\/components\/spotlight/);
    expect(beams).toMatch(
      /Source: https:\/\/ui\.aceternity\.com\/components\/background-beams/,
    );
  });
});
