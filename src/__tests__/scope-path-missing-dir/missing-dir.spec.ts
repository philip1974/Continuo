// BDD:尚不存在的 scope 目录,授权落地的路径与校验侧在同一空间。见同目录 README。
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
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

  // 真 Windows 上 node:path 把 `\\` 当分隔符,无法模拟 POSIX 的路径拆分。
  it.skipIf(process.platform === 'win32')('其它平台:回退值原样(`\\` 是合法文件名字符,不动)', async () => {
    platformMock.value = 'linux';
    expect(await canonicalizeScopePath('/continuo-no-such/a\\b')).toBe('/continuo-no-such/a\\b');
  });
});

describe('尚不存在的 scope 目录 · 已存在的上级目录', () => {
  it('最近的已存在上级被 realpath,尚不存在的部分原样接上', async () => {
    const root = mkdtempSync(join(tmpdir(), 'continuo-scope-missing-'));
    tempRoots.push(root);
    const real = realpathSync.native(root);
    expect(await canonicalizeScopePath(join(root, 'a', 'b') + sep)).toBe(join(real, 'a', 'b'));
  });

  // Windows 由系统按字面折叠 `..`(`root\a\..` 就是 root,存在),不适用。
  it.skipIf(process.platform === 'win32')('尚不存在的部分不折叠 `..`', async () => {
    const root = mkdtempSync(join(tmpdir(), 'continuo-scope-missing-'));
    tempRoots.push(root);
    expect(await canonicalizeScopePath(`${root}/a/../b`)).toBe(
      `${realpathSync.native(root)}/a/../b`,
    );
  });

  it('相对路径不被解析成 cwd 下的绝对路径', async () => {
    expect(await canonicalizeScopePath('continuo-no-such-relative/dir')).toBe(
      ['continuo-no-such-relative', 'dir'].join(sep),
    );
  });
});

describe('尚不存在的 scope 目录 · 端到端', () => {
  async function grantThenCreate(requested: string, dir: string): Promise<void> {
    const identity = new IdentityRegistry();
    const registry = new PathScopeRegistry(identity);
    const { token } = identity.register('com.test', 10);
    registry.grant('com.test', [{ path: await canonicalizeScopePath(requested), mode: 'r' }]);

    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'f.txt');
    writeFileSync(file, 'ok');
    await expect(registry.check(token, 10, 'read', file, 'r')).resolves.toEqual({
      canonical: realpathSync.native(file),
    });
  }

  // 临时目录故意不预先 realpath:macOS 上它在 /var(→ /private/var)下,Windows runner 上是 8.3 短名
  //(RUNNER~1),正是「上级没被解析」的真实形态;Windows 上再用正斜杠书写,覆盖分隔符。
  it('授权时目录不存在 → 之后创建 → 目录内读取通过校验', async () => {
    const root = mkdtempSync(join(tmpdir(), 'continuo-scope-missing-'));
    tempRoots.push(root);
    const requested =
      process.platform === 'win32'
        ? `${root.replaceAll('\\', '/')}/later/out`
        : join(root, 'later', 'out');
    await grantThenCreate(requested, join(root, 'later', 'out'));
  });

  it('上级目录是符号链接 → 同样通过', async () => {
    const root = mkdtempSync(join(tmpdir(), 'continuo-scope-missing-'));
    tempRoots.push(root);
    const link = `${root}-link`;
    symlinkSync(root, link, 'dir');
    tempRoots.push(link);
    await grantThenCreate(join(link, 'later'), join(link, 'later'));
  });
});
