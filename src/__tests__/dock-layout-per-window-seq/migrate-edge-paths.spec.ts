import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  defaultExplorerV3,
  loadExplorer,
  migrateExplorerFileToV3,
  type ExplorerPayload,
} from '../../../electron/main/persistence';

let dir: string;
let explorerFile: string;
let legacyLayoutFile: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'continuo-migrate-v3-'));
  explorerFile = path.join(dir, 'explorer.json');
  legacyLayoutFile = path.join(dir, 'layout.json');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const v2Payload: ExplorerPayload = {
  version: 2,
  workspace: { recentRoots: ['/work'] },
  pinned: { paths: ['/work/pinned.md'] },
  nextWindowSeq: 2,
  windows: [
    {
      windowSeq: 0,
      workspace: { root: '/work' },
      explorer: {
        activePath: '/work/a.md',
        expandedPaths: ['/work'],
        sort: { by: 'name', reverse: false },
      },
    },
  ],
};

describe('migrateExplorerFileToV3 edge paths', () => {
  it('T11: no explorer.json and no legacy layout.json is a no-op', async () => {
    await migrateExplorerFileToV3(explorerFile, legacyLayoutFile);

    expect(existsSync(explorerFile)).toBe(false);
    expect(existsSync(legacyLayoutFile)).toBe(false);
  });

  it('T11: layout-only path creates default v3 explorer and removes legacy layout', async () => {
    await fs.writeFile(legacyLayoutFile, JSON.stringify({ version: 1, panels: {} }));

    await migrateExplorerFileToV3(explorerFile, legacyLayoutFile);

    expect(await loadExplorer(explorerFile)).toEqual(defaultExplorerV3());
    expect(existsSync(legacyLayoutFile)).toBe(false);
  });

  it('T11: v2-only explorer path rewrites explorer.json as v3', async () => {
    await fs.writeFile(explorerFile, JSON.stringify(v2Payload));

    await migrateExplorerFileToV3(explorerFile, legacyLayoutFile);

    const migrated = await loadExplorer(explorerFile);
    expect(migrated?.version).toBe(3);
    expect(migrated?.windows[0]?.workspace.root).toBe('/work');
    const raw = JSON.parse(await fs.readFile(explorerFile, 'utf-8')) as { version: number };
    expect(raw.version).toBe(3);
  });

  it('T11: mixed explorer plus legacy layout rewrites v3 and removes legacy layout', async () => {
    await fs.writeFile(explorerFile, JSON.stringify(v2Payload));
    await fs.writeFile(legacyLayoutFile, JSON.stringify({ version: 1, panels: {} }));

    await migrateExplorerFileToV3(explorerFile, legacyLayoutFile);

    const migrated = await loadExplorer(explorerFile);
    expect(migrated?.version).toBe(3);
    expect(migrated?.windows[0]?.workspace.root).toBe('/work');
    expect(existsSync(legacyLayoutFile)).toBe(false);
  });

  it('T11: corrupt explorer.json skips migration and keeps legacy layout for manual recovery', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fs.writeFile(explorerFile, '{not json');
    await fs.writeFile(legacyLayoutFile, JSON.stringify({ version: 1 }));

    await migrateExplorerFileToV3(explorerFile, legacyLayoutFile);

    expect(warn).toHaveBeenCalled();
    expect(await fs.readFile(explorerFile, 'utf-8')).toBe('{not json');
    expect(existsSync(legacyLayoutFile)).toBe(true);
  });
});
