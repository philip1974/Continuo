import { beforeEach, describe, expect, it, vi } from 'vitest';

const dataHandlers = vi.hoisted(() => [] as Array<(chunk: string) => void>);
const exitHandlers = vi.hoisted(() => [] as Array<(info: { exitCode: number; signal?: number }) => void>);

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn((cb: (chunk: string) => void) => {
      dataHandlers.push(cb);
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn((cb: (info: { exitCode: number; signal?: number }) => void) => {
      exitHandlers.push(cb);
      return { dispose: vi.fn() };
    }),
    kill: vi.fn(),
    resize: vi.fn(),
    write: vi.fn(),
    pid: 12345,
  })),
}));

import { SessionManager } from '@continuo-terminal/server-node';

async function sessionWithChunks(chunks: string[]): Promise<{ sm: SessionManager; id: string }> {
  const sm = new SessionManager({ maxBytes: 4096 });
  const created = await sm.create({ cwd: '/tmp' });
  const onData = dataHandlers.at(-1);
  if (!onData) throw new Error('missing onData handler');
  for (const chunk of chunks) {
    onData(chunk);
  }
  return { sm, id: created.session_id };
}

describe('migration step2 buffer merge · ansi strip regression', () => {
  beforeEach(() => {
    dataHandlers.length = 0;
    exitHandlers.length = 0;
  });

  it('strips CSI color sequences', async () => {
    const { sm, id } = await sessionWithChunks(['\x1b[31mred\x1b[0m\n']);

    const out = await sm.readOutput({ session_id: id, strip_ansi: true });

    expect(out.lines).toEqual(['red']);
    expect(out.lines.join('\n')).not.toMatch(/\x1b\[/);
  });

  it('strips OSC sequences', async () => {
    const { sm, id } = await sessionWithChunks(['\x1b]0;title\x07prompt\n']);

    const out = await sm.readOutput({ session_id: id, strip_ansi: true });

    expect(out.lines).toEqual(['prompt']);
    expect(out.lines.join('\n')).not.toMatch(/\x1b\]/);
  });

  it('strips multiple nested CSI sequences', async () => {
    const { sm, id } = await sessionWithChunks(['\x1b[1m\x1b[32mok\x1b[0m\n']);

    const out = await sm.readOutput({ session_id: id, strip_ansi: true });

    expect(out.lines).toEqual(['ok']);
  });

  it('strips single-character ESC sequences', async () => {
    const { sm, id } = await sessionWithChunks(['a\x1bc\n']);

    const out = await sm.readOutput({ session_id: id, strip_ansi: true });

    expect(out.lines).toEqual(['a']);
  });

  it('leaves plain text unchanged', async () => {
    const { sm, id } = await sessionWithChunks(['plain text\n']);

    const out = await sm.readOutput({ session_id: id, strip_ansi: true });

    expect(out.lines).toEqual(['plain text']);
  });

  it('strips ANSI split across chunks after SessionBuffer concatenation', async () => {
    const { sm, id } = await sessionWithChunks(['\x1b[31', 'mred\x1b[0m\n']);

    const out = await sm.readOutput({ session_id: id, strip_ansi: true });

    expect(out.lines).toEqual(['red']);
  });
});
