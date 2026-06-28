import { execFile as execFileCb } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFile = promisify(execFileCb);
const root = process.cwd();
const adapterPath = path.join(
  root,
  'scripts/debug-spike/.adapter/js-debug/src/dapDebugServer.js',
);
const runScript = path.join(root, 'scripts/debug-spike/run.mjs');
const adapterExists = existsSync(adapterPath);
const itWithAdapter = adapterExists ? it : it.skip;

async function runSpike(args: string[]) {
  return execFile(process.execPath, [runScript, ...args], {
    cwd: root,
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024,
  });
}

describe('49 · agent-controllable debug spike', () => {
  itWithAdapter(
    'Phase 0a DAP 闭环命中断点、读取变量链并 evaluate',
    async () => {
      const { stdout } = await runSpike([]);

      expect(stdout).toContain('[debug-spike] stopped(reason=breakpoint)');
      expect(stdout).toContain('frame source=');
      expect(stdout).toContain('fixture.ts:14');
      expect(stdout).toContain('variables nested.answer=42');
      expect(stdout).toContain("variables nested.inner.k='v'");
      expect(stdout).toContain('variables sum=21');
      expect(stdout).toContain('evaluate nested.answer=42');
      expect(stdout).toContain("evaluate nested.inner.k='v'");
      expect(stdout).toContain('evaluate arr.length=3');
      expect(stdout).toContain('evaluate sum=21');
    },
    130_000,
  );

  itWithAdapter(
    'POSIX teardown 强杀后 adapter 与 debuggee 进程树反收',
    async () => {
      const { stdout } = await runSpike(['--teardown']);

      expect(stdout).toContain('teardown POSIX-only; Windows deferred Phase 1');
      expect(stdout).toContain('adapter pid=');
      expect(stdout).toContain('debuggee pids=');
      expect(stdout).toContain('teardown SIGTERM at');
      expect(stdout).toContain('teardown final alive pid=none');
      expect(stdout).toContain('teardown result=PASS');
    },
    130_000,
  );
});
