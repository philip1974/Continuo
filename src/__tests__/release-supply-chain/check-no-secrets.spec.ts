// 发布前机密扫描:v0.2.5 安装包曾把 GitHub token 打进 app.asar。scripts/check-no-secrets.mjs
// 扫构建产物,命中即非零退出且不回显命中值。假 token 用字符串拼接生成,源码里不出现完整字面量。

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts', 'check-no-secrets.mjs');

const FAKE = {
  github: 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
  pat: 'github' + '_pat_' + '11ABCDEFG0123456789_abcdefghijklmnop',
  aws: 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP',
  key: '-----BEGIN ' + 'RSA PRIVATE KEY-----',
};

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'continuo-secret-scan-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('check-no-secrets:构建产物机密扫描', () => {
  it('干净目录 → 退出码 0', () => {
    mkdirSync(join(dir, 'renderer'));
    writeFileSync(join(dir, 'renderer', 'index.js'), 'console.log("ok"); const gh = "ghp_short";');
    expect(run(dir).code).toBe(0);
  });

  it.each(Object.entries(FAKE))('含 %s 形态的机密 → 非零退出,只输出文件与偏移,不输出值', (_name, value) => {
    const file = join(dir, 'main.js');
    writeFileSync(file, `var x = 1;\nconst t = "${value}";\n`);
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${file}:${'var x = 1;\nconst t = "'.length}`);
    expect(r.out).not.toContain(value);
  });

  it('二进制 app.asar(未压缩归档)内的 token 也能扫到;--packaged 只扫 app.asar 不扫框架二进制', () => {
    const res = join(dir, 'mac-arm64', 'Continuo.app', 'Contents', 'Resources');
    mkdirSync(res, { recursive: true });
    const asar = Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from(FAKE.github), Buffer.alloc(16)]);
    writeFileSync(join(res, 'app.asar'), asar);
    const fw = join(dir, 'mac-arm64', 'Continuo.app', 'Contents', 'Frameworks');
    mkdirSync(fw, { recursive: true });
    writeFileSync(join(fw, 'Electron Framework'), FAKE.aws);
    const r = run('--packaged', dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`app.asar:4`);
    expect(r.out).not.toContain('Electron Framework');
  });

  it('跨 8MiB 读块边界的 token 也能扫到', () => {
    const pad = 8 * 1024 * 1024 - 10;
    const file = join(dir, 'big.js');
    writeFileSync(file, Buffer.concat([Buffer.alloc(pad, 0x20), Buffer.from(FAKE.github), Buffer.alloc(4096, 0x20)]));
    const r = run(file);
    expect(r.code).toBe(1);
    expect(r.out.match(/疑似机密/g)).toHaveLength(1);
    expect(r.out).toContain(`big.js:${pad}`);
  });

  it('跳过压缩容器(.dmg/.zip):明文匹配不到,其内容由 .app / app.asar 覆盖', () => {
    writeFileSync(join(dir, 'Continuo.dmg'), FAKE.github);
    expect(run(dir).code).toBe(0);
  });

  it('fail-closed:路径不存在,或 --packaged 目录里一个 app.asar 都没有 → 退出码 2', () => {
    expect(run(join(dir, 'nope')).code).toBe(2);
    expect(run('--packaged', dir).code).toBe(2);
    expect(run().code).toBe(2);
  });
});

describe('接线:打包与 CI 自动执行扫描', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('所有 build:app* 在 electron-builder 之后运行扫描(out-pack 全量 + dist-electron 的 app.asar)', () => {
    expect(pkg.scripts['check:secrets:pack']).toBe(
      'node scripts/check-no-secrets.mjs out-pack --packaged dist-electron',
    );
    const appScripts = Object.entries(pkg.scripts).filter(([n]) => n.startsWith('build:app'));
    expect(appScripts.length).toBeGreaterThan(0);
    for (const [, cmd] of appScripts) {
      expect(cmd).toMatch(/electron-builder[^&]*&& pnpm check:secrets:pack$/);
    }
  });

  it('CI 有独立步骤在 pnpm build 之后扫 out/', () => {
    const ci = readFileSync(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8');
    const build = ci.indexOf('run: pnpm build\n');
    const scan = ci.indexOf('run: node scripts/check-no-secrets.mjs out');
    expect(build).toBeGreaterThan(-1);
    expect(scan).toBeGreaterThan(build);
  });
});
