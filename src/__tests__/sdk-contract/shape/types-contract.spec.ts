import { describe, expectTypeOf, it } from 'vitest';
import type {
  CoWorkspaceApi,
  PluginFsApi,
  PluginShellApi,
} from '../../../plugins/types';
import type { PluginDataStore } from '../../../plugins/PluginDataStore';

describe('sdk-contract shape: plugin-facing TypeScript surface', () => {
  it('T1 pins PluginFsApi file and atomic replace signatures', () => {
    expectTypeOf<PluginFsApi['readFile']>().parameters.toEqualTypeOf<
      [path: string]
    >();
    expectTypeOf<PluginFsApi['readFile']>().returns.resolves.toEqualTypeOf<string>();

    expectTypeOf<PluginFsApi['writeFile']>().parameters.toEqualTypeOf<
      [path: string, content: string]
    >();
    expectTypeOf<PluginFsApi['writeFile']>().returns.resolves.toEqualTypeOf<void>();

    expectTypeOf<PluginFsApi['atomicReplaceWithinScope']>().parameters.toEqualTypeOf<
      [staging: string, final: string, opts?: { overwrite?: boolean }]
    >();
    expectTypeOf<
      PluginFsApi['atomicReplaceWithinScope']
    >().returns.resolves.toEqualTypeOf<void>();
  });

  it('T2 pins PluginShellApi buffered and streaming signatures', () => {
    expectTypeOf<PluginShellApi['exec']>().parameters.toEqualTypeOf<
      [
        cmd: string,
        args: readonly string[],
        opts?: {
          readonly cwd?: string;
          readonly env?: Readonly<Record<string, string>>;
          readonly timeoutMs?: number;
          readonly input?: string;
          readonly maxOutputBytes?: number;
        },
      ]
    >();
    expectTypeOf<PluginShellApi['exec']>().returns.resolves.toMatchTypeOf<{
      readonly stdout: string;
      readonly stderr: string;
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly timedOut: boolean;
      readonly truncated: boolean;
    }>();

    expectTypeOf<PluginShellApi['execStream']>().parameters.toEqualTypeOf<
      [cmd: string, args: string[], opts?: { timeoutMs?: number; cwd?: string }]
    >();
    expectTypeOf<PluginShellApi['execStream']>().returns.toEqualTypeOf<{
      chunks: AsyncIterable<{ stream: 'stdout' | 'stderr'; chunk: Uint8Array }>;
      done: Promise<{ exitCode: number; signal: NodeJS.Signals | null }>;
    }>();
  });

  it('T3 pins PluginDataStore read/write signatures', () => {
    expectTypeOf<PluginDataStore['read']>().parameters.toEqualTypeOf<
      [pluginId: string]
    >();
    expectTypeOf<PluginDataStore['read']>().returns.resolves.toEqualTypeOf<
      unknown | null
    >();
    expectTypeOf<PluginDataStore['write']>().parameters.toEqualTypeOf<
      [pluginId: string, data: unknown]
    >();
    expectTypeOf<PluginDataStore['write']>().returns.resolves.toEqualTypeOf<void>();
  });

  it('T4 pins CoWorkspaceApi.getRoot return shape', () => {
    expectTypeOf<CoWorkspaceApi['getRoot']>().parameters.toEqualTypeOf<[]>();
    expectTypeOf<CoWorkspaceApi['getRoot']>().returns.resolves.toEqualTypeOf<
      string | null
    >();
  });
});
