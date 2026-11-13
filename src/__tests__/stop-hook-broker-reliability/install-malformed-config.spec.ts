// @vitest-environment node
// BDD:安装 stop hook 时畸形的用户配置不崩、不被覆盖。见同目录 README。
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  inferRunner,
  installStopHookForSession,
} from '../../../electron/main/services/mcp-tools-hook-bridge';

let cwd: string;
let settingsPath: string;
const hookEventsDir = '/tmp/continuo-hook-events-malformed-test';
const ccRunner = inferRunner({ id: 't', cwd: '/r', agentLabel: 'claude' });

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'stophook-malformed-'));
  settingsPath = join(cwd, '.claude', 'settings.local.json');
  await mkdir(join(cwd, '.claude'), { recursive: true });
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('安装 stop hook · 畸形的用户配置', () => {
  it('hooks.Stop[].hooks 里有 null → 跳过该项,正常安装且保留原有键', async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({ userKey: 'keep-me', hooks: { Stop: [{ hooks: [null, 'x', 1] }] } }),
      'utf8',
    );
    const res = await installStopHookForSession(cwd, ccRunner, hookEventsDir);
    expect(res.installed).toBe(true);
    const parsed = JSON.parse(await readFile(settingsPath, 'utf8'));
    expect(parsed.userKey).toBe('keep-me');
  });

  it.each([
    ['数组', '[1,2,3]'],
    ['标量', '"just a string"'],
    ['null', 'null'],
  ])('配置文件顶层是%s → parse-error,文件原样不动', async (_label, text) => {
    await writeFile(settingsPath, text, 'utf8');
    const res = await installStopHookForSession(cwd, ccRunner, hookEventsDir);
    expect(res).toMatchObject({ installed: false, reason: 'parse-error' });
    expect(await readFile(settingsPath, 'utf8')).toBe(text);
  });
});
