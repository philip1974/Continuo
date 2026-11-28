// 工作区信任(VSCode Workspace Trust / 受限模式)真实 Electron 下的端到端行为。CONTINUO_E2E_WORKSPACE_TRUST=1 打开真实行为
//(其余 e2e 默认关闭信任,见 helpers/launch)。原生信任对话框由 main 弹,Playwright 点不到 → 在 main 里替换
// dialog.showMessageBox 记录调用并按需应答。git 用无害探针:PATH 最前放一个 `git` 包装脚本,只在宿主 git 状态查询的 env
//(GIT_OPTIONAL_LOCKS=0 + GIT_TERMINAL_PROMPT=0)下记一行工作目录,再交给真实 git。
//   1. 打开新文件夹 → 弹信任对话框 → 不信任 → 状态栏「受限模式」、git 探针一次都没跑、无 git 装饰
//      → 管理工作区信任里「信任」(对话框选信任)→ 状态栏项消失、git 装饰出现;重启保留(不再询问、装饰照常)
//   2. 勾选「信任上级文件夹」→ 上级下的另一个子文件夹不再询问;上级之外的文件夹照常询问
// BDD: src/__tests__/workspace-trust/
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { waitForAppReady, waitForTestHooks } from './helpers/app-ready';

// 状态栏项的可访问名 = VSCode ariaLabel「受限模式：某些功能已禁用…」(以可见文字开头)
const RESTRICTED = /^(受限模式|Restricted Mode|제한 모드)/;
const TRUST_BUTTON = /^(信任|Trust|신뢰)$/;
const TRUST_MESSAGE = /(是否信任此文件夹中的文件的作者|Do you trust the authors of the files in this folder|이 폴더에 있는 파일의 작성자를 신뢰합니까)/;

interface TrustCall {
  readonly message: string;
  readonly checkboxLabel: string | null;
}

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function realGit(): string {
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'git');
    if (dir !== '' && existsSync(candidate)) return candidate;
  }
  throw new Error('git not found on PATH');
}

function gitIn(cwd: string, ...args: string[]): void {
  execFileSync(realGit(), ['-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

/** 临时根目录:probe/git(探针)、probe.log、ud(userData)、各工作区。 */
function makeBase(): { base: string; probeLog: string; env: Record<string, string> } {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'continuo-e2e-trust-')));
  dirs.push(base);
  const probeDir = path.join(base, 'probe');
  mkdirSync(probeDir);
  const probeLog = path.join(base, 'probe.log');
  writeFileSync(probeLog, '');
  const script = path.join(probeDir, 'git');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      `if [ "$GIT_OPTIONAL_LOCKS" = "0" ] && [ "$GIT_TERMINAL_PROMPT" = "0" ]; then printf '%s\\n' "$PWD" >> '${probeLog}'; fi`,
      `exec '${realGit()}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(script, 0o755);
  return {
    base,
    probeLog,
    env: { CONTINUO_E2E_WORKSPACE_TRUST: '1', PATH: `${probeDir}${path.delimiter}${process.env['PATH'] ?? ''}` },
  };
}

function makeRepo(dir: string): void {
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'README.md'), '# trust\n');
  gitIn(dir, 'init', '-q');
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  writeFileSync(path.join(dir, 'new.ts'), 'x\n');
}

async function launch(ud: string, env: Record<string, string>): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await launchContinuo(ud, { env });
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await waitForAppReady(win);
  await waitForTestHooks(win, 15_000);
  return { app, win };
}

/** 替换原生信任对话框:记录调用,按 globalThis.__trustAnswer 应答(默认「不信任」)。 */
async function stubTrustDialog(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __trustCalls: TrustCall[]; __trustAnswer: { response: number; checkboxChecked: boolean } };
    g.__trustCalls = [];
    g.__trustAnswer = { response: 1, checkboxChecked: false };
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const opts = args.find((a) => a && typeof a === 'object' && 'buttons' in (a as object)) as
        | { message?: string; checkboxLabel?: string }
        | undefined;
      g.__trustCalls.push({ message: opts?.message ?? '', checkboxLabel: opts?.checkboxLabel ?? null });
      return g.__trustAnswer;
    }) as unknown as typeof dialog.showMessageBox;
  });
}

const trustCalls = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __trustCalls: TrustCall[] }).__trustCalls);
const setTrustAnswer = (app: ElectronApplication, response: number, checkboxChecked: boolean) =>
  app.evaluate(
    (_e, a) => {
      (globalThis as unknown as { __trustAnswer: unknown }).__trustAnswer = a;
    },
    { response, checkboxChecked },
  );

async function openFolder(app: ElectronApplication, win: Page, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  }, dir);
  expect(await win.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.action.files.openFolder'))).toBe(true);
  await expect(win.locator(`footer [title="${dir}"]`)).toBeVisible({ timeout: 15_000 });
}

const restrictedItem = (win: Page) => win.locator('footer').getByRole('button', { name: RESTRICTED });
const row = (win: Page, name: string) =>
  win.locator('[role=treeitem]').filter({ has: win.locator('span.truncate', { hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) }) });
const nameOf = (win: Page, name: string) => row(win, name).locator('span.truncate');
const probeHits = (log: string, dir: string) =>
  readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l !== '' && (l === dir || l.startsWith(`${dir}/`))).length;

test('打开新文件夹 → 不信任:受限模式、不跑 git → 管理里信任:装饰即时出现;重启保留', async () => {
  test.setTimeout(120_000);
  const { base, probeLog, env } = makeBase();
  const repo = path.join(base, 'repo');
  makeRepo(repo);
  const ud = path.join(base, 'ud');
  mkdirSync(ud);

  const { app, win } = await launch(ud, env);
  await stubTrustDialog(app);
  await openFolder(app, win, repo);

  // 首次打开 → 询问一次(带「信任上级文件夹」复选框);默认应答「不信任」
  await expect.poll(async () => (await trustCalls(app)).length, { timeout: 10_000 }).toBe(1);
  const [first] = await trustCalls(app);
  expect(first!.message).toMatch(TRUST_MESSAGE);
  expect(first!.checkboxLabel).toContain(path.basename(base));
  await expect(restrictedItem(win)).toBeVisible({ timeout: 10_000 });

  // 受限模式:触发刷新来源(文件变化 / 获焦)后仍无装饰、探针零调用
  await expect(row(win, 'new.ts')).toBeVisible({ timeout: 10_000 });
  writeFileSync(path.join(repo, 'README.md'), '# changed\n');
  await win.evaluate(() => window.dispatchEvent(new Event('focus')));
  await win.waitForTimeout(3_000);
  await expect(nameOf(win, 'new.ts')).not.toHaveClass(/text-git-/);
  expect(probeHits(probeLog, repo)).toBe(0);

  // 管理工作区信任 →「信任」→ 原生对话框选信任
  await setTrustAnswer(app, 0, false);
  expect(await win.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.trust.manage'))).toBe(true);
  const modal = win.getByRole('dialog');
  await modal.getByRole('button', { name: TRUST_BUTTON }).click();
  await expect.poll(async () => (await trustCalls(app)).length).toBe(2);
  await expect(restrictedItem(win)).toHaveCount(0, { timeout: 10_000 });
  await expect(nameOf(win, 'new.ts')).toHaveClass(/\btext-git-untracked\b/, { timeout: 10_000 });
  expect(probeHits(probeLog, repo)).toBeGreaterThan(0);
  await win.keyboard.press('Escape');

  // 重启:恢复同一文件夹,已信任 → 不询问(若弹出真实对话框会卡住,装饰不会出现)、装饰照常
  await closeDiscardingUnsaved(app);
  apps.splice(apps.indexOf(app), 1);
  const second = await launch(ud, env);
  await expect(nameOf(second.win, 'new.ts')).toHaveClass(/\btext-git-untracked\b/, { timeout: 15_000 });
  await expect(restrictedItem(second.win)).toHaveCount(0);
  const saved = JSON.parse(readFileSync(path.join(ud, 'workspace-trust.json'), 'utf8')) as { trusted: string[] };
  expect(saved.trusted).toEqual([repo]);
});

test('勾选「信任上级文件夹」→ 上级下的其它子文件夹不再询问;上级之外照常询问', async () => {
  test.setTimeout(90_000);
  const { base, env } = makeBase();
  const parent = path.join(base, 'parent');
  const a = path.join(parent, 'a');
  const b = path.join(parent, 'b');
  const outside = path.join(base, 'outside');
  for (const d of [a, b, outside]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'file.txt'), 'x\n');
  }
  const ud = path.join(base, 'ud');
  mkdirSync(ud);

  const { app, win } = await launch(ud, env);
  await stubTrustDialog(app);
  await setTrustAnswer(app, 0, true);
  await openFolder(app, win, a);
  await expect.poll(async () => (await trustCalls(app)).length, { timeout: 10_000 }).toBe(1);
  expect((await trustCalls(app))[0]!.checkboxLabel).toContain('parent');
  await expect(restrictedItem(win)).toHaveCount(0);

  await openFolder(app, win, b);
  await win.waitForTimeout(1_500);
  expect(await trustCalls(app)).toHaveLength(1);
  await expect(restrictedItem(win)).toHaveCount(0);

  await setTrustAnswer(app, 1, false);
  await openFolder(app, win, outside);
  await expect.poll(async () => (await trustCalls(app)).length, { timeout: 10_000 }).toBe(2);
  await expect(restrictedItem(win)).toBeVisible({ timeout: 10_000 });
});
