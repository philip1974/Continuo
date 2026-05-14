import { describe, expect, it, vi } from 'vitest';
import { removePtyOnce } from '../../panels/Terminal/spawnLeaf';

describe('terminal pane internal split - remove pty dedup set', () => {
  it('calls terminal.remove only once per pty id across close paths', () => {
    const removed = new Set<string>();
    const remove = vi.fn().mockResolvedValue({ ok: true });

    removePtyOnce('pty-1', removed, remove, 'leaf-close');
    removePtyOnce('pty-1', removed, remove, 'tab-close');
    removePtyOnce('pty-2', removed, remove, 'panel-close');

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenNthCalledWith(1, 'pty-1');
    expect(remove).toHaveBeenNthCalledWith(2, 'pty-2');
  });

  it('warns on rejected and ok=false removal results', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const removed = new Set<string>();

    removePtyOnce(
      'pty-bad',
      removed,
      vi.fn().mockResolvedValue({ ok: false, code: 'ENOENT' }),
      'tab-close',
    );
    removePtyOnce('pty-reject', removed, vi.fn().mockRejectedValue(new Error('boom')), 'panel-close');
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith(
      '[pane-split] tab-close remove ok=false',
      'pty-bad',
      expect.objectContaining({ ok: false }),
    );
    expect(warn).toHaveBeenCalledWith(
      '[pane-split] panel-close remove rejected',
      'pty-reject',
      expect.any(Error),
    );
  });
});
