import { beforeEach, describe, expect, it } from 'vitest';

import {
  _reset,
  clearWindow,
  getWorkspaceRoot,
  isAnyWorkspaceRoot,
  setWorkspaceRoot,
} from '../../../electron/main/services/window-workspace-roots.service';

beforeEach(() => {
  _reset();
});

describe('window workspace roots service API', () => {
  it('T1: setWorkspaceRoot + getWorkspaceRoot returns the root', () => {
    setWorkspaceRoot(1, '/a');

    expect(getWorkspaceRoot(1)).toBe('/a');
  });

  it('T2: setWorkspaceRoot(null) removes the mapping', () => {
    setWorkspaceRoot(1, '/a');
    setWorkspaceRoot(1, null);

    expect(getWorkspaceRoot(1)).toBeNull();
  });

  it('T3: multiple windows keep independent workspace roots', () => {
    setWorkspaceRoot(1, '/a');
    setWorkspaceRoot(2, '/b');

    expect(getWorkspaceRoot(1)).toBe('/a');
    expect(getWorkspaceRoot(2)).toBe('/b');
  });

  it('T4a: setting the same windowId replaces the previous root', () => {
    setWorkspaceRoot(1, '/a');
    setWorkspaceRoot(1, '/b');

    expect(getWorkspaceRoot(1)).toBe('/b');
  });

  it('T4b: a cleared windowId can be rebuilt with a new root', () => {
    setWorkspaceRoot(1, '/a');
    setWorkspaceRoot(1, null);
    setWorkspaceRoot(1, '/b');

    expect(getWorkspaceRoot(1)).toBe('/b');
  });

  it('T5: clearWindow removes the mapping', () => {
    setWorkspaceRoot(1, '/a');
    clearWindow(1);

    expect(getWorkspaceRoot(1)).toBeNull();
  });

  it('T35: isAnyWorkspaceRoot matches any window root (platform-aware, trailing sep tolerated)', () => {
    setWorkspaceRoot(1, '/a');
    setWorkspaceRoot(2, 'C:\\Code\\Proj');

    expect(isAnyWorkspaceRoot('/a')).toBe(true);
    expect(isAnyWorkspaceRoot('/a/')).toBe(true);
    expect(isAnyWorkspaceRoot('/a/sub')).toBe(false);
    expect(isAnyWorkspaceRoot('/b')).toBe(false);
    expect(isAnyWorkspaceRoot('c:\\code\\proj', 'win32')).toBe(true);
    expect(isAnyWorkspaceRoot('/A', 'linux')).toBe(false);

    clearWindow(1);
    expect(isAnyWorkspaceRoot('/a')).toBe(false);
  });

  it('T6: _reset clears all mappings', () => {
    setWorkspaceRoot(1, '/a');
    setWorkspaceRoot(2, '/b');
    _reset();

    expect(getWorkspaceRoot(1)).toBeNull();
    expect(getWorkspaceRoot(2)).toBeNull();
  });
});
