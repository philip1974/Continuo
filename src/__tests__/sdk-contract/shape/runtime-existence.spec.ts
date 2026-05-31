import { describe, expect, it } from 'vitest';
import { coApp } from '../../../plugins/co-app';
import { createScopedApp } from '../../../plugins/scoped-app';

describe('sdk-contract shape: runtime SDK object existence', () => {
  it('T2.a exposes workspace.getRoot on coApp', () => {
    expect(typeof coApp.workspace.getRoot).toBe('function');
  });

  it('T2.b exposes DataStore read/write on coApp', () => {
    expect(typeof coApp.dataStore.read).toBe('function');
    expect(typeof coApp.dataStore.write).toBe('function');
  });

  it('T2.c exposes existing contribution registries on coApp', () => {
    expect(typeof coApp.commands.register).toBe('function');
    expect(typeof coApp.panels.register).toBe('function');
    expect(typeof coApp.mcp.register).toBe('function');
  });

  it('T2.d exposes scoped fs methods promised to plugins', () => {
    const scoped = createScopedApp(coApp, 'sdk-contract.runtime', null, 'token');
    expect(typeof scoped.fs.readFile).toBe('function');
    expect(typeof scoped.fs.writeFile).toBe('function');
    expect(typeof scoped.fs.listDir).toBe('function');
    expect(typeof scoped.fs.userHome).toBe('function');
    expect(typeof scoped.fs.atomicReplaceWithinScope).toBe('function');
  });

  it('T2.e exposes scoped shell methods promised to plugins', () => {
    const scoped = createScopedApp(coApp, 'sdk-contract.runtime', null, 'token');
    expect(typeof scoped.shell.exec).toBe('function');
    expect(typeof scoped.shell.execStream).toBe('function');
  });

  it('T2.f exposes scoped network and clipboard methods promised to plugins', () => {
    const scoped = createScopedApp(coApp, 'sdk-contract.runtime', null, 'token');
    expect(typeof scoped.network.fetch).toBe('function');
    expect(typeof scoped.clipboard.readText).toBe('function');
  });
});
