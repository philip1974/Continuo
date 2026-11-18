// 发布前机密扫描:v0.2.5 安装包曾把 GitHub token 打进 app.asar。scripts/check-no-secrets.mjs
// 扫构建产物,命中即非零退出且不回显命中值。假 token 用字符串拼接生成,源码里不出现完整字面量。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts', 'check-no-secrets.mjs');

const FAKE = {
  github: 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
  pat: 'github' + '_pat_' + '11ABCDEFG0123456789_abcdefghijklmnop',
  aws: 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP',
  key: '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  npm: 'np' + 'm_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
  openai: 's' + 'k-' + 'A1b2C3d4E5f6G7h8I9j0K1l2',
  // 带前缀的新形态:前缀后的主体含 - 与 _。
  openaiProject: 's' + 'k-' + 'proj-' + 'A1b2_C3d4-E5f6G7h8I9j0K1l2',
  openaiServiceAccount: 's' + 'k-' + 'svcacct-' + 'A1b2_C3d4-E5f6G7h8I9j0K1l2',
  openaiAdmin: 's' + 'k-' + 'admin-' + 'A1b2_C3d4-E5f6G7h8I9j0K1l2',
  anthropic: 's' + 'k-' + 'ant-api03-' + 'A1b2_C3d4-E5f6G7h8I9j0K1l2',
  slack: 'xo' + 'xb-' + '1234567890-abcdefGHIJ',
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

  it('连字符分隔的普通标识符(CSS 类名 / 事件名里的 …sk-…)不误报', () => {
    writeFileSync(
      join(dir, 'index.css'),
      '.task-list-item-checkbox-wrapper{} .mask-image-linear-gradient-from{} "risk-proj-assessment-summary-view"',
    );
    expect(run(dir).code).toBe(0);
  });

  // 多行文本(如 .env 模板)被内联成 JS / JSON 字符串时,密钥独占一行 → 产物字节是 `…\\nsk-proj-…`,
  // sk- 前一个字节是转义字母 n / r / t,不能因此当成「标识符内部」而放过。
  it.each(['n', 'r', 't'])('带前缀的 sk- 密钥紧跟字符串转义 \\%s → 仍命中', (esc) => {
    writeFileSync(join(dir, 'main.js'), `const env = "KEY=1\\${esc}${FAKE.openaiProject}";`);
    expect(run(dir).code).toBe(1);
    writeFileSync(join(dir, 'main.js'), `const env = "x\\${esc}${FAKE.anthropic}";`);
    expect(run(dir).code).toBe(1);
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

  it('--packaged 也扫 app.asar 同目录的 extraResources(continuo-mcp-stdio.mjs、js-debug/)', () => {
    const res = join(dir, 'mac-arm64', 'Continuo.app', 'Contents', 'Resources');
    mkdirSync(join(res, 'js-debug', 'src'), { recursive: true });
    writeFileSync(join(res, 'app.asar'), 'clean');
    writeFileSync(join(res, 'continuo-mcp-stdio.mjs'), `const t = "${FAKE.github}";`);
    writeFileSync(join(res, 'js-debug', 'src', 'dapDebugServer.js'), `const t = "${FAKE.npm}";`);
    const r = run('--packaged', dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('continuo-mcp-stdio.mjs:');
    expect(r.out).toContain('dapDebugServer.js:');
  });

  it('命中时删除本次构建的分发产物(dmg/zip/blockmap/SHA256SUMS/latest*.yml),保留 .app 与历史版本', () => {
    const res = join(dir, 'mac-arm64', 'Continuo.app', 'Contents', 'Resources');
    mkdirSync(res, { recursive: true });
    const asar = join(res, 'app.asar');
    writeFileSync(asar, FAKE.github);
    const t = Date.now() / 1000;
    utimesSync(asar, t - 60, t - 60);
    const fresh = [
      'Continuo-9.9.9-arm64.dmg',
      'Continuo-9.9.9-arm64-mac.zip',
      'Continuo-9.9.9-arm64.dmg.blockmap',
      'SHA256SUMS.txt',
      'latest-mac.yml',
    ];
    for (const f of fresh) writeFileSync(join(dir, f), 'x');
    const old = join(dir, 'Continuo-0.0.1-arm64.dmg');
    writeFileSync(old, 'x');
    utimesSync(old, t - 86400, t - 86400);
    const r = run('--packaged', dir);
    expect(r.code).toBe(1);
    for (const f of fresh) expect(existsSync(join(dir, f)), f).toBe(false);
    expect(existsSync(old)).toBe(true);
    expect(existsSync(asar)).toBe(true);
  });

  // dist-electron 留有旧构建的解包目录(如早先另一架构的 mac/)时,删除范围不得以它的 app.asar 为起点。
  describe('输出目录里同时有旧构建的解包目录与旧安装包', () => {
    const DAY = 86400;
    let newAsar: string;
    let oldInstaller: string;
    let newInstaller: string;
    beforeEach(() => {
      const t = Date.now() / 1000;
      const oldRes = join(dir, 'mac', 'Continuo.app', 'Contents', 'Resources');
      const newRes = join(dir, 'mac-arm64', 'Continuo.app', 'Contents', 'Resources');
      mkdirSync(oldRes, { recursive: true });
      mkdirSync(newRes, { recursive: true });
      writeFileSync(join(oldRes, 'app.asar'), 'clean');
      utimesSync(join(oldRes, 'app.asar'), t - 10 * DAY, t - 10 * DAY);
      oldInstaller = join(dir, 'Continuo-0.0.1.dmg');
      writeFileSync(oldInstaller, 'x');
      utimesSync(oldInstaller, t - 5 * DAY, t - 5 * DAY);
      newAsar = join(newRes, 'app.asar');
      writeFileSync(newAsar, 'clean');
      utimesSync(newAsar, t - 60, t - 60);
      newInstaller = join(dir, 'Continuo-9.9.9-arm64.dmg');
      writeFileSync(newInstaller, 'x');
    });

    it('命中在新解包目录 → 只删其 app.asar 之后生成的安装包,历史版本安装包保留', () => {
      const t = Date.now() / 1000;
      writeFileSync(newAsar, FAKE.github);
      utimesSync(newAsar, t - 60, t - 60);
      expect(run('--packaged', dir).code).toBe(1);
      expect(existsSync(newInstaller)).toBe(false);
      expect(existsSync(oldInstaller)).toBe(true);
    });

    it('命中只在位置参数目录(out-pack)→ 按最新 app.asar 删本次安装包,历史版本安装包保留', () => {
      const outPack = join(dir, 'out-pack');
      mkdirSync(outPack);
      writeFileSync(join(outPack, 'main.js'), FAKE.github);
      expect(run(outPack, '--packaged', dir).code).toBe(1);
      expect(existsSync(newInstaller)).toBe(false);
      expect(existsSync(oldInstaller)).toBe(true);
    });
  });

  it('未命中时不删除任何产物', () => {
    const res = join(dir, 'mac-arm64', 'Continuo.app', 'Contents', 'Resources');
    mkdirSync(res, { recursive: true });
    writeFileSync(join(res, 'app.asar'), 'clean');
    writeFileSync(join(dir, 'Continuo-9.9.9-arm64.dmg'), 'x');
    expect(run('--packaged', dir).code).toBe(0);
    expect(existsSync(join(dir, 'Continuo-9.9.9-arm64.dmg'))).toBe(true);
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
