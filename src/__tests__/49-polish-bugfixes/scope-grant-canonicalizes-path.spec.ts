// P2 功能契约回归(第八 session R3):授予的 plugin-fs scope 路径此前裸存原始字符串,
// 而 PathScopeRegistry.check 的 probe 走 expandHome + realpath(去符号链接的绝对 canonical)。
// 两者不在同一空间 →
//   1) `~/proj`(types.ts:149 文档明确「`~` allowed (expanded host-side)」)授予后永不匹配
//      → 该 scope 静默死掉,插件后续所有 fs 操作误拒 ScopeError;
//   2) 含符号链接组件的根(如 macOS `/tmp`→`/private/tmp`)同样失配。
// 二者都是 fail-closed(误拒非越权)但破坏文档契约。既有 path-scope-registry.test.ts:52 等
// 全部预先 `realpathSync(root)` 再 grant —— 恰好假设「调用方已归一化」,掩盖了生产 grant
// 调用方(plugin-fs:request-scope handler)未归一化的契约缺口。
//
// 修复:新增 canonicalizeScopePath(expandHome + realpath + 去尾分隔符,ENOENT 回退展开值),
// request-scope handler 落地 grant 前对每个 scope.path 归一化,与 check probe 对称。
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeScopePath } from '../../../electron/main/services/path-resolve.helper';
import { IdentityRegistry } from '../../../electron/main/services/identity-registry.service';
import { PathScopeRegistry } from '../../../electron/main/services/path-scope-registry.service';
import { ScopeError } from '../../plugins/types';
import { canonicalizePathScopes } from '../../../electron/main/services/plugin-fs.service';

const tempRoots: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'continuo-scope-canon-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('49 第八 session · canonicalizeScopePath', () => {
  it('`~` 展开到 homedir 的 realpath(文档承诺)', async () => {
    const out = await canonicalizeScopePath('~');
    expect(out).toBe(realpathSync(homedir()));
    expect(out).not.toContain('~');
  });

  it('`~/sub` 展开 + 去符号链接', async () => {
    const out = await canonicalizeScopePath('~/.'); // homedir 自身
    expect(out).toBe(realpathSync(homedir()));
  });

  it('符号链接根被 realpath 解析到真实目标', async () => {
    const real = makeTempDir();
    const target = join(real, 'inner');
    mkdirSync(target);
    const link = `${real}-link`;
    symlinkSync(target, link, 'dir');
    tempRoots.push(link);
    expect(await canonicalizeScopePath(link)).toBe(realpathSync(target));
  });

  it('去尾分隔符(`/dir/` → `/dir`),让 `path + sep` 前缀匹配成立', async () => {
    const real = makeTempDir();
    expect(await canonicalizeScopePath(real + '/')).toBe(realpathSync(real));
  });

  it('`~user` 形式无法展开 → 退化为原始路径(不抛,避免 Promise.all 毒死整批 grant)', async () => {
    // 对抗自审 4a:expandHome 对 `~someuser/...` 抛 ScopeError。canonicalizeScopePath
    // 必须吞掉退化为裸值,否则 request-scope 的 Promise.all 会因一条畸形 scope 整体 reject,
    // 把同请求的合法 scope 一起丢弃 + 'grant' 决议变 IPC 异常(改动前裸存不会)。
    await expect(
      canonicalizeScopePath('~someuser_that_throws/proj'),
    ).resolves.toBe('~someuser_that_throws/proj');
  });

  it('不存在的目录 ENOENT → 回退到展开值(仍把 `~` 展开,不抛)', async () => {
    // expandHome 用 homedir() 拼接(realpath 失败时不解析),回退值即 homedir()/<sub>。
    const out = await canonicalizeScopePath('~/__continuo_nonexistent_dir__');
    expect(out).toBe(join(homedir(), '__continuo_nonexistent_dir__'));
    expect(out).not.toContain('~');
  });

  it('request-scope 批量归一化单趟预分配,不调用 scopes.map', async () => {
    const real = makeTempDir();
    const missing = join(real, 'missing');
    const scopes = [
      { path: real, mode: 'r' as const },
      { path: missing, mode: 'rw' as const },
    ];
    const mapSpy = vi.spyOn(scopes, 'map');
    try {
      await expect(canonicalizePathScopes(scopes)).resolves.toEqual([
        { path: realpathSync(real), mode: 'r' },
        { path: missing, mode: 'rw' },
      ]);
      expect(mapSpy).not.toHaveBeenCalled();
    } finally {
      mapSpy.mockRestore();
    }
  });
});

describe('49 第八 session · symlink scope 归一化后 check 匹配(端到端)', () => {
  it('归一化的符号链接 scope → check 匹配;裸存符号链接 scope → 失配(证明修复必要)', async () => {
    const real = makeTempDir();
    const file = join(real, 'f.txt');
    writeFileSync(file, 'ok');
    const link = `${real}-link`;
    symlinkSync(real, link, 'dir');
    tempRoots.push(link);

    // —— 修复后:grant 前归一化 link → realpath(real) ——
    {
      const identity = new IdentityRegistry();
      const registry = new PathScopeRegistry(identity);
      const { token } = identity.register('com.test', 10);
      const canonical = await canonicalizeScopePath(link);
      registry.grant('com.test', [{ path: canonical, mode: 'r' }]);
      // 目标经 link 访问,probe realpath 到 real/f.txt → 命中 canonical(=realpath real)
      await expect(
        registry.check(token, 10, 'read', join(link, 'f.txt'), 'r'),
      ).resolves.toEqual({ canonical: realpathSync(file) });
    }

    // —— 修复前(裸存 link):probe=realpath(real)/f.txt 不以 link 为前缀 → ScopeError ——
    {
      const identity = new IdentityRegistry();
      const registry = new PathScopeRegistry(identity);
      const { token } = identity.register('com.test', 11);
      registry.grant('com.test', [{ path: link, mode: 'r' }]); // 未归一化
      await expect(
        registry.check(token, 11, 'read', join(link, 'f.txt'), 'r'),
      ).rejects.toThrow(ScopeError);
    }
  });
});
