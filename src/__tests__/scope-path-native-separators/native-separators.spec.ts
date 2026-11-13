// BDD:尚不存在的 scope 目录,授权落地的路径使用本平台分隔符。见同目录 README。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityRegistry } from '../../../electron/main/services/identity-registry.service';
import { PathScopeRegistry } from '../../../electron/main/services/path-scope-registry.service';

const platformMock = vi.hoisted(() => ({ value: null as NodeJS.Platform | null }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: () => platformMock.value ?? actual.platform() };
});

const { canonicalizeScopePath } = await import(
  '../../../electron/main/services/path-resolve.helper'
);

const tempRoots: string[] = [];

afterEach(() => {
  platformMock.value = null;
  vi.unstubAllEnvs();
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('尚不存在的 scope 目录 · 回退值的分隔符', () => {
  it('Windows:`~/dir` 展开后全部是反斜杠', async () => {
    platformMock.value = 'win32';
    vi.stubEnv('USERPROFILE', 'C:\\Users\\continuo-no-such-user');
    expect(await canonicalizeScopePath('~/proj/out')).toBe(
      'C:\\Users\\continuo-no-such-user\\proj\\out',
    );
  });

  it('Windows:正斜杠书写的绝对路径也换成反斜杠;只换分隔符,不折叠 `..`', async () => {
    platformMock.value = 'win32';
    expect(await canonicalizeScopePath('C:/continuo-no-such/a/../out/')).toBe(
      'C:\\continuo-no-such\\a\\..\\out',
    );
  });

  it('其它平台:回退值原样(`\\` 是合法文件名字符,不动)', async () => {
    platformMock.value = 'linux';
    expect(await canonicalizeScopePath('/continuo-no-such/a\\b')).toBe('/continuo-no-such/a\\b');
  });
});

describe('尚不存在的 scope 目录 · 端到端', () => {
  // 在 Windows 上这是真实复现:正斜杠书写 → 修复前落地成混合分隔符,目录创建后永远匹配不上。
  it('授权时目录不存在(路径用正斜杠书写)→ 之后创建 → 目录内读取通过校验', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'continuo-scope-sep-')));
    tempRoots.push(root);
    const requested = `${root.replaceAll('\\', '/')}/later/out`;

    const identity = new IdentityRegistry();
    const registry = new PathScopeRegistry(identity);
    const { token } = identity.register('com.test', 10);
    registry.grant('com.test', [{ path: await canonicalizeScopePath(requested), mode: 'r' }]);

    const dir = join(root, 'later', 'out');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'f.txt');
    writeFileSync(file, 'ok');
    await expect(registry.check(token, 10, 'read', file, 'r')).resolves.toEqual({
      canonical: realpathSync(file),
    });
  });
});
