// 插件 data.json 跨窗口缓存失效(renderer)。两个 IpcPluginDataStore 模拟窗口 A / B,共享 main 侧 data.json 替身;
// main 替身在 save 成功后把 { id } 广播给发起窗口以外的窗口。见同目录 README.md。
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (payload: unknown) => void;

const h = vi.hoisted(() => ({
  disk: {} as Record<string, string>,
  /** 每个窗口的订阅;sender 标记当前发起 save 的窗口。 */
  subs: [] as { win: string; cb: Listener }[],
  sender: '',
  loads: 0,
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginDataRaw: {
      load: async (id: string) => {
        h.loads += 1;
        const s = h.disk[id];
        return s === undefined ? {} : { value: JSON.parse(s) };
      },
      saveSerialized: async (id: string, serialized: string) => {
        h.disk[id] = serialized;
        for (const s of h.subs) if (s.win !== h.sender) s.cb({ id });
      },
      onChanged: (cb: Listener) => {
        const entry = { win: h.sender, cb };
        h.subs.push(entry);
        return () => {
          h.subs = h.subs.filter((s) => s !== entry);
        };
      },
    },
  },
}));

import { IpcPluginDataStore, wirePluginDataInvalidation } from '../../plugins/PluginDataStore';

const ID = 'com.skills.manager';

/** 窗口内的操作都在 h.sender = 该窗口时执行(main 据此跳过发起窗口)。 */
function makeWindow(name: string) {
  h.sender = name;
  const store = new IpcPluginDataStore();
  wirePluginDataInvalidation(store);
  const inWin = async <T>(fn: () => Promise<T>): Promise<T> => {
    h.sender = name;
    return fn();
  };
  return {
    store,
    read: () => inWin(() => store.read(ID)) as Promise<Record<string, unknown> | null>,
    write: (data: unknown) => inWin(() => store.write(ID, data)),
  };
}

beforeEach(() => {
  h.disk = { [ID]: JSON.stringify({ catalogUrl: 'old', catalogCache: [] }) };
  h.subs = [];
  h.sender = '';
  h.loads = 0;
});

describe('renderer:plugin-data 写后其它窗口缓存失效', () => {
  it('A 写入后 B 的下一次 read 重新从盘读,得到新值', async () => {
    const a = makeWindow('A');
    const b = makeWindow('B');
    expect(await b.read()).toEqual({ catalogUrl: 'old', catalogCache: [] }); // B 已缓存
    await a.read();

    await a.write({ catalogUrl: 'new', catalogCache: [] });

    expect(await b.read()).toEqual({ catalogUrl: 'new', catalogCache: [] });
  });

  it('B 整份读-改-写不再抹掉 A 的设置', async () => {
    const a = makeWindow('A');
    const b = makeWindow('B');
    await b.read();
    await a.read();

    // A:设置里改目录 URL 并保存
    const fromA = (await a.read())!;
    await a.write({ ...fromA, catalogUrl: 'new' });

    // B:刷新目录 → 读整份、改缓存字段、整份写回
    const fromB = (await b.read())!;
    await b.write({ ...fromB, catalogCache: ['x'] });

    expect(JSON.parse(h.disk[ID]!)).toEqual({ catalogUrl: 'new', catalogCache: ['x'] });
  });

  it('发起窗口自身不失效:A 写后 A 的 read 命中缓存、不重读盘', async () => {
    const a = makeWindow('A');
    makeWindow('B');
    await a.read();
    const loadsBefore = h.loads;
    await a.write({ catalogUrl: 'mine' });
    expect(await a.read()).toEqual({ catalogUrl: 'mine' });
    expect(h.loads).toBe(loadsBefore);
  });

  it('畸形广播 payload → 丢弃,不失效缓存', async () => {
    const b = makeWindow('B');
    await b.read();
    const loadsBefore = h.loads;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const bad of [null, 'com.skills.manager', { id: 1 }, {}]) {
      for (const s of h.subs) expect(() => s.cb(bad)).not.toThrow();
    }
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
    await b.read();
    expect(h.loads).toBe(loadsBefore);
  });
});
