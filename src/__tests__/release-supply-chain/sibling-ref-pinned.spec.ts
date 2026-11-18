// sibling 依赖 ContinuoTerminal(package.json `file:../ContinuoTerminal/...`)固定到
// .continuo-terminal-ref 记录的 commit:CI 按它检出,本地打包前核对工作区干净且 HEAD 一致。

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts', 'check-sibling-ref.mjs');

function git(cwd: string, ...args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();
}

let dir: string;
let sibling: string;
let app: string;
let refFile: string;
let head: string;

const PKG = '@ct/pkg';
const pkgSrc = () => join(sibling, 'packages', 'pkg');
const installed = () => join(app, 'node_modules', '@ct', 'pkg');

function run(siblingDir = sibling) {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--ref-file', refFile, '--sibling', siblingDir, '--root', app],
    { encoding: 'utf8' },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// 模拟 pnpm install:把 sibling 包目录当前内容复制进 app/node_modules(真实 pnpm 为硬链接副本)。
function install() {
  rmSync(installed(), { recursive: true, force: true });
  cpSync(pkgSrc(), installed(), { recursive: true });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'continuo-sibling-ref-'));
  sibling = join(dir, 'ContinuoTerminal');
  mkdirSync(join(sibling, 'packages', 'pkg', 'src'), { recursive: true });
  git(sibling, 'init', '-q');
  writeFileSync(join(sibling, 'a.txt'), 'a');
  writeFileSync(join(pkgSrc(), 'package.json'), JSON.stringify({ name: PKG }));
  writeFileSync(join(pkgSrc(), 'src', 'index.ts'), 'export const v = 1;\n');
  git(sibling, 'add', '.');
  git(sibling, 'commit', '-q', '-m', 'init');
  head = git(sibling, 'rev-parse', 'HEAD');
  refFile = join(dir, '.continuo-terminal-ref');
  writeFileSync(refFile, `${head}\n`);
  app = join(dir, 'app');
  mkdirSync(app);
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ dependencies: { [PKG]: 'file:../ContinuoTerminal/packages/pkg', other: '^1.0.0' } }),
  );
  install();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('check-sibling-ref:打包前核对 ContinuoTerminal 版本', () => {
  it('工作区干净且 HEAD 等于记录的 SHA → 通过', () => {
    expect(run().code).toBe(0);
  });

  it('HEAD 与记录不一致 → 中止并提示两个 SHA', () => {
    writeFileSync(join(sibling, 'b.txt'), 'b');
    git(sibling, 'add', '.');
    git(sibling, 'commit', '-q', '-m', 'next');
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain(head);
  });

  it.each([
    ['已跟踪文件被修改', (d: string) => writeFileSync(join(d, 'a.txt'), 'changed')],
    ['存在未跟踪文件', (d: string) => writeFileSync(join(d, 'new.txt'), 'x')],
  ])('工作区不干净(%s)→ 中止', (_n, dirty) => {
    dirty(sibling);
    expect(run().code).toBe(1);
  });

  it('记录文件缺失或不是 40 位 SHA → 中止', () => {
    writeFileSync(refFile, 'main\n');
    expect(run().code).toBe(1);
    rmSync(refFile);
    expect(run().code).toBe(1);
  });

  it('sibling 不存在,或只是外层仓库里的普通子目录 → 中止(不误用外层仓库 HEAD)', () => {
    expect(run(join(dir, 'missing')).code).toBe(1);
    const nested = join(sibling, 'sub');
    mkdirSync(nested);
    writeFileSync(join(nested, 'x.txt'), 'x');
    git(sibling, 'add', '.');
    git(sibling, 'commit', '-q', '-m', 'nested');
    writeFileSync(refFile, `${git(sibling, 'rev-parse', 'HEAD')}\n`);
    expect(run(nested).code).toBe(1);
  });
});

describe('check-sibling-ref:node_modules 里的 file: 依赖副本须等于固定 SHA 的内容', () => {
  // 场景:sibling 停在未审查 commit X 时 pnpm install,再 checkout 回固定 SHA、不重装就打包。
  // HEAD 校验通过,但 node_modules 里的硬链接副本仍是 X 的内容(checkout 新建文件会断开硬链接)。
  function installAtUnreviewedCommitThenCheckoutBack(mutate: () => void) {
    git(sibling, 'checkout', '-q', '-b', 'x');
    mutate();
    git(sibling, 'add', '-A');
    git(sibling, 'commit', '-q', '-m', 'unreviewed');
    install();
    git(sibling, 'checkout', '-q', head);
  }

  it('已安装副本的文件内容与固定 SHA 不同 → 中止并提示 pnpm install', () => {
    installAtUnreviewedCommitThenCheckoutBack(() =>
      writeFileSync(join(pkgSrc(), 'src', 'index.ts'), 'export const v = "evil";\n'),
    );
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('pnpm install');
    expect(r.out).toContain('src/index.ts');
  });

  it('已安装副本多出固定 SHA 未跟踪的文件 → 中止', () => {
    installAtUnreviewedCommitThenCheckoutBack(() => writeFileSync(join(pkgSrc(), 'src', 'extra.ts'), 'x'));
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/extra.ts');
  });

  it('已安装副本缺失 → 中止', () => {
    rmSync(installed(), { recursive: true, force: true });
    expect(run().code).toBe(1);
  });

  it('副本内嵌套的 node_modules(pnpm 放置的依赖链接)不参与比对 → 通过', () => {
    mkdirSync(join(installed(), 'node_modules', 'zod'), { recursive: true });
    writeFileSync(join(installed(), 'node_modules', 'zod', 'index.js'), 'x');
    expect(run().code).toBe(0);
  });

  it('package.json 里一个指向 sibling 的 file: 依赖都找不到 → 中止(fail-closed)', () => {
    writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { other: '^1.0.0' } }));
    expect(run().code).toBe(1);
  });
});

describe('接线:记录文件、打包前检查与 CI 检出', () => {
  it('.continuo-terminal-ref 是 40 位 commit SHA', () => {
    expect(readFileSync(join(ROOT, '.continuo-terminal-ref'), 'utf8').trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('所有 build:app* 第一步运行 check:sibling-ref', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['check:sibling-ref']).toBe('node scripts/check-sibling-ref.mjs');
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      if (name.startsWith('build:app')) expect(cmd.startsWith('pnpm check:sibling-ref && ')).toBe(true);
    }
  });

  it('workflow 不再裸 clone ContinuoTerminal,一律经固定 SHA 的检出脚本', () => {
    for (const wf of ['ci.yml', 'e2e.yml']) {
      const text = readFileSync(join(ROOT, '.github', 'workflows', wf), 'utf8');
      expect(text).not.toMatch(/git clone[^\n]*ContinuoTerminal/);
      expect(text).toContain('run: bash scripts/ci-checkout-continuo-terminal.sh');
    }
    const sh = readFileSync(join(ROOT, 'scripts', 'ci-checkout-continuo-terminal.sh'), 'utf8');
    expect(sh).toContain('.continuo-terminal-ref');
    expect(sh).toMatch(/fetch --depth 1 origin "\$ref"/);
    expect(sh).toMatch(/checkout --detach "\$ref"/);
  });
});
