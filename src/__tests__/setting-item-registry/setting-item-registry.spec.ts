import { describe, it, expect, vi } from 'vitest';
import {
  SettingItemRegistry,
  clampSettingNumber,
  hasSettingEnumValue,
  type SettingItemSpec,
} from '../../plugins/registries/SettingItemRegistry';

describe('SettingItemRegistry', () => {
  it('select enum value 查找单趟扫描,不调用 enum.some', () => {
    const options = [
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ];
    const someSpy = vi.spyOn(options, 'some');

    try {
      expect(hasSettingEnumValue(options, 'dark')).toBe(true);
      expect(hasSettingEnumValue(options, 'system')).toBe(false);
      expect(someSpy).not.toHaveBeenCalled();
    } finally {
      someSpy.mockRestore();
    }
  });

  it('register / dispose / getAll', () => {
    const r = new SettingItemRegistry();
    const d = r.register({
      id: 'general.theme',
      category: 'general',
      title: '主题',
      type: 'select',
      default: 'dark',
      enum: [
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ],
    });
    expect(r.getAll().map((x) => x.id)).toEqual(['general.theme']);
    d.dispose();
    expect(r.getAll()).toEqual([]);
  });

  // race(R58,R50 同族):SettingItemRow 写前按 id 复查 setting 仍注册。get(id) 提供 live 查找。
  it('get(id) live 查找:register→spec / dispose→undefined', () => {
    const r = new SettingItemRegistry();
    const d = r.register({
      id: 'general.flag',
      category: 'general',
      title: 'Flag',
      type: 'boolean',
      default: false,
    });
    expect(r.get('general.flag')?.id).toBe('general.flag');
    d.dispose();
    expect(r.get('general.flag')).toBeUndefined();
  });

  it('getByCategory 过滤 + 排序', () => {
    const r = new SettingItemRegistry();
    r.register({
      id: 'editor.fontSize',
      category: 'editor',
      title: '字号',
      type: 'number',
      default: 14,
      priority: 10,
    });
    r.register({
      id: 'general.theme',
      category: 'general',
      title: '主题',
      type: 'select',
      default: 'dark',
      enum: [
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ],
      priority: 1,
    });
    r.register({
      id: 'editor.lineNumbers',
      category: 'editor',
      title: '行号',
      type: 'boolean',
      default: true,
      priority: 5,
    });
    expect(r.getByCategory('editor').map((s) => s.id)).toEqual([
      'editor.lineNumbers',
      'editor.fontSize',
    ]);
    expect(r.getByCategory('general').map((s) => s.id)).toEqual([
      'general.theme',
    ]);
    expect(r.getByCategory('nope')).toEqual([]);
  });

  it('重复读取 getByCategory/getAll 复用排序结果,register/dispose 后失效重建', () => {
    const r = new SettingItemRegistry();
    const d = r.register({
      id: 'editor.fontSize',
      category: 'editor',
      title: '字号',
      type: 'number',
      default: 14,
      priority: 20,
    });
    r.register({
      id: 'editor.lineNumbers',
      category: 'editor',
      title: '行号',
      type: 'boolean',
      default: true,
      priority: 10,
    });
    r.register({
      id: 'general.theme',
      category: 'general',
      title: '主题',
      type: 'select',
      default: 'dark',
      enum: [
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ],
      priority: 5,
    });
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      expect(r.getByCategory('editor').map((s) => s.id)).toEqual([
        'editor.lineNumbers',
        'editor.fontSize',
      ]);
      expect(sortSpy).toHaveBeenCalledTimes(1);
      expect(r.getByCategory('editor').map((s) => s.id)).toEqual([
        'editor.lineNumbers',
        'editor.fontSize',
      ]);
      expect(sortSpy).toHaveBeenCalledTimes(1);

      expect(r.getAll().map((s) => s.id)).toEqual([
        'general.theme',
        'editor.lineNumbers',
        'editor.fontSize',
      ]);
      expect(sortSpy).toHaveBeenCalledTimes(2);
      expect(r.getAll().map((s) => s.id)).toEqual([
        'general.theme',
        'editor.lineNumbers',
        'editor.fontSize',
      ]);
      expect(sortSpy).toHaveBeenCalledTimes(2);

      r.register({
        id: 'editor.tabSize',
        category: 'editor',
        title: 'Tab',
        type: 'number',
        default: 2,
        priority: 5,
      });
      expect(r.getByCategory('editor').map((s) => s.id)).toEqual([
        'editor.tabSize',
        'editor.lineNumbers',
        'editor.fontSize',
      ]);
      expect(sortSpy).toHaveBeenCalledTimes(3);

      d.dispose();
      expect(r.getByCategory('editor').map((s) => s.id)).toEqual([
        'editor.tabSize',
        'editor.lineNumbers',
      ]);
      expect(sortSpy).toHaveBeenCalledTimes(4);
      expect(SettingItemRegistry.prototype.getByCategory.toString()).not.toContain(
        'items.push(',
      );
      expect(SettingItemRegistry.prototype.getAll.toString()).not.toContain(
        'items.push(',
      );
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('getByCategory 不先 Array.from(values) 物化全部条目', () => {
    const r = new SettingItemRegistry();
    r.register({
      id: 'editor.fontSize',
      category: 'editor',
      title: '字号',
      type: 'number',
      default: 14,
    });
    r.register({
      id: 'general.theme',
      category: 'general',
      title: '主题',
      type: 'select',
      default: 'dark',
      enum: [
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ],
    });
    const arrayFromSpy = vi.spyOn(Array, 'from');

    try {
      expect(r.getByCategory('editor').map((s) => s.id)).toEqual([
        'editor.fontSize',
      ]);
      expect(arrayFromSpy).not.toHaveBeenCalled();
    } finally {
      arrayFromSpy.mockRestore();
    }
  });

  // 打磨 R5:getByCategory 改为先 filter 再 sort。等优先级时必须保持注册顺序
  // (稳定排序),且只受本 category 项影响 — 锁住「filter 在前」的等价性。
  it('同 category 等优先级 → 保持注册顺序(稳定排序)', () => {
    const r = new SettingItemRegistry();
    const mk = (id: string, category: string) => ({
      id,
      category,
      title: id,
      type: 'boolean' as const,
      default: true,
      priority: 50,
    });
    r.register(mk('editor.a', 'editor'));
    r.register(mk('general.x', 'general')); // 交错的无关 category 项
    r.register(mk('editor.b', 'editor'));
    r.register(mk('editor.c', 'editor'));
    expect(r.getByCategory('editor').map((s) => s.id)).toEqual([
      'editor.a',
      'editor.b',
      'editor.c',
    ]);
  });

  it('priority 升序;缺失默认 100', () => {
    const r = new SettingItemRegistry();
    r.register({
      id: 'mid',
      category: 'g',
      title: 'M',
      type: 'boolean',
      default: false,
    });
    r.register({
      id: 'top',
      category: 'g',
      title: 'T',
      type: 'boolean',
      default: false,
      priority: 1,
    });
    r.register({
      id: 'bot',
      category: 'g',
      title: 'B',
      type: 'boolean',
      default: false,
      priority: 200,
    });
    expect(r.getAll().map((s) => s.id)).toEqual(['top', 'mid', 'bot']);
  });

  it('重复 id → 后注册赢 + warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = new SettingItemRegistry();
    r.register({
      id: 'dup',
      category: 'g',
      title: 'A',
      type: 'boolean',
      default: false,
    });
    r.register({
      id: 'dup',
      category: 'g',
      title: 'B',
      type: 'boolean',
      default: true,
    });
    expect(warn).toHaveBeenCalled();
    expect(r.getAll()).toHaveLength(1);
    expect(r.getAll()[0]?.title).toBe('B');
    warn.mockRestore();
  });

  it('subscribe 通知 register/dispose;dispose 后不再触发', () => {
    const r = new SettingItemRegistry();
    const cb = vi.fn();
    const unsub = r.subscribe(cb);
    const d = r.register({
      id: 'a',
      category: 'g',
      title: 'A',
      type: 'boolean',
      default: false,
    });
    expect(cb).toHaveBeenCalledTimes(1);
    d.dispose();
    expect(cb).toHaveBeenCalledTimes(2);
    unsub();
    r.register({
      id: 'b',
      category: 'g',
      title: 'B',
      type: 'boolean',
      default: false,
    });
    expect(cb).toHaveBeenCalledTimes(2); // unsubscribed
  });

  it('dispose 幂等', () => {
    const r = new SettingItemRegistry();
    const d = r.register({
      id: 'a',
      category: 'g',
      title: 'A',
      type: 'boolean',
      default: false,
    });
    d.dispose();
    d.dispose(); // 不抛
    expect(r.getAll()).toEqual([]);
  });
});

// 边界(E6):number setting 须按 spec.min/max clamp,防越界/畸形值致 UI/xterm/autosave 异常。
describe('clampSettingNumber (E6)', () => {
  const spec: SettingItemSpec = {
    id: 'editor.fontSize',
    category: 'editor',
    title: 'font',
    type: 'number',
    default: 14,
    min: 8,
    max: 40,
  };

  it('范围内 → 原样', () => {
    expect(clampSettingNumber(spec, 14)).toBe(14);
    expect(clampSettingNumber(spec, 8)).toBe(8);
    expect(clampSettingNumber(spec, 40)).toBe(40);
  });

  it('低于 min → clamp 到 min', () => {
    expect(clampSettingNumber(spec, 0)).toBe(8);
    expect(clampSettingNumber(spec, -5)).toBe(8);
  });

  it('高于 max → clamp 到 max', () => {
    expect(clampSettingNumber(spec, 9999)).toBe(40);
  });

  it('NaN / Infinity 非有限 → 回退 default(再经 clamp 仍在范围内)', () => {
    expect(clampSettingNumber(spec, NaN)).toBe(14);
    expect(clampSettingNumber(spec, Infinity)).toBe(14); // 非有限→default 14,14 在 [8,40]
  });

  it('无 min/max 的 spec → 仅过滤非有限', () => {
    const open: SettingItemSpec = {
      id: 'x',
      category: 'c',
      title: 't',
      type: 'number',
      default: 100,
    };
    expect(clampSettingNumber(open, 99999)).toBe(99999);
    expect(clampSettingNumber(open, NaN)).toBe(100);
  });
});

// 边界(E36,E35 兄弟 registry):register 校验贡献项(长度/枚举/数值 finite/default 类型),防畸形
// 插件超大枚举冻结设置页、NaN/Infinity 数值参数让排序/控件异常、类型不匹配 default。非法抛、不入。
describe('SettingItemRegistry register 边界校验 (E36)', () => {
  const valid: SettingItemSpec = {
    id: 'general.theme',
    category: 'general',
    title: '主题',
    type: 'select',
    default: 'dark',
    enum: [
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ],
  };

  it('合法 spec → ok', () => {
    const r = new SettingItemRegistry();
    expect(() => r.register(valid)).not.toThrow();
    expect(r.getAll()).toHaveLength(1);
  });

  it('超长 id/title → 抛,不入 registry', () => {
    const r = new SettingItemRegistry();
    expect(() =>
      r.register({ ...valid, id: 'x'.repeat(257) }),
    ).toThrow(/id.*max length/i);
    expect(() =>
      r.register({ ...valid, title: 'T'.repeat(513) }),
    ).toThrow(/title.*max length/i);
    expect(r.getAll()).toEqual([]);
  });

  it('enum 数量超 256 → 抛', () => {
    const r = new SettingItemRegistry();
    const hugeEnum = Array.from({ length: 257 }, (_, i) => ({
      value: `v${i}`,
      label: `L${i}`,
    }));
    expect(() => r.register({ ...valid, enum: hugeEnum })).toThrow(
      /enum count/i,
    );
  });

  it('enum option 超长 → 抛', () => {
    const r = new SettingItemRegistry();
    expect(() =>
      r.register({
        ...valid,
        enum: [{ value: 'v'.repeat(513), label: 'L' }],
      }),
    ).toThrow(/enum option/i);
  });

  it('非有限 priority/min/max/step → 抛', () => {
    const r = new SettingItemRegistry();
    const num: SettingItemSpec = {
      id: 'editor.size',
      category: 'editor',
      title: 'Size',
      type: 'number',
      default: 14,
    };
    expect(() => r.register({ ...num, priority: NaN })).toThrow(/finite/i);
    expect(() => r.register({ ...num, min: Infinity })).toThrow(/finite/i);
    expect(() => r.register({ ...num, max: NaN })).toThrow(/finite/i);
    expect(() => r.register({ ...num, step: Infinity })).toThrow(/finite/i);
  });

  it('min > max / step <= 0 → 抛', () => {
    const r = new SettingItemRegistry();
    const num: SettingItemSpec = {
      id: 'editor.size',
      category: 'editor',
      title: 'Size',
      type: 'number',
      default: 14,
    };
    expect(() => r.register({ ...num, min: 40, max: 8 })).toThrow(
      /min must be <= max/i,
    );
    expect(() => r.register({ ...num, step: 0 })).toThrow(/step must be > 0/i);
  });

  it('default 与 type 不匹配 → 抛', () => {
    const r = new SettingItemRegistry();
    expect(() =>
      r.register({
        id: 'a',
        category: 'c',
        title: 't',
        type: 'boolean',
        default: 'nope' as never,
      }),
    ).toThrow(/default does not match type/i);
    expect(() =>
      r.register({
        id: 'b',
        category: 'c',
        title: 't',
        type: 'number',
        default: NaN,
      }),
    ).toThrow(/default does not match type/i);
  });

  // 边界(E141):string default(text/select)长度上限 + select.default 必须 ∈ enum。
  it('E141 超长 string default(text/select)→ 抛', () => {
    const r = new SettingItemRegistry();
    expect(() =>
      r.register({
        id: 'longtext',
        category: 'c',
        title: 't',
        type: 'text',
        default: 'x'.repeat(8193),
      }),
    ).toThrow(/default exceeds max length/i);
    expect(r.getAll()).toEqual([]);
  });

  it('E141 select.default 不在 enum 内 → 抛(否则 E139 回退仍回到非法值)', () => {
    const r = new SettingItemRegistry();
    expect(() =>
      r.register({ ...valid, default: 'not-an-option' }),
    ).toThrow(/select default must be one of enum/i);
    expect(r.getAll()).toEqual([]);
  });

  it('E141 select.default ∈ enum → ok', () => {
    const r = new SettingItemRegistry();
    expect(() => r.register({ ...valid, default: 'light' })).not.toThrow();
  });

  // 边界(E154,E153/E36 兄弟):SettingItemSpec 来自未类型化 JS plugin,TS 类型≠运行时保证。
  // E36/E141 只对字符串字段做 .length,假设它们都是 string;畸形 spec(id:{}/category:123/
  // title:true/titleKey:{})会绕过(`({}).length === undefined > max` 为 false)进 registry。
  describe('E154 · 字段运行时类型校验', () => {
    const bad = (spec: unknown) => (r: SettingItemRegistry) =>
      r.register(spec as never);

    it('必填 id/category/title 非字符串 → 抛 + 不入 registry', () => {
      const r = new SettingItemRegistry();
      expect(() =>
        bad({ ...valid, id: {} })(r),
      ).toThrow(/id must be a non-empty string/i);
      expect(() =>
        bad({ ...valid, category: 123 })(r),
      ).toThrow(/category must be a non-empty string/i);
      expect(() =>
        bad({ ...valid, title: true })(r),
      ).toThrow(/title must be a non-empty string/i);
      expect(r.getAll()).toEqual([]);
    });

    it('必填 id/category/title 空字符串 → 抛', () => {
      const r = new SettingItemRegistry();
      expect(() => bad({ ...valid, id: '' })(r)).toThrow(
        /id must be a non-empty string/i,
      );
      expect(() => bad({ ...valid, category: '' })(r)).toThrow(
        /category must be a non-empty string/i,
      );
      expect(() => bad({ ...valid, title: '' })(r)).toThrow(
        /title must be a non-empty string/i,
      );
    });

    it('可选字段非字符串(titleKey:{} / group:1 / unit:true)→ 抛', () => {
      const r = new SettingItemRegistry();
      expect(() => bad({ ...valid, titleKey: {} })(r)).toThrow(
        /titleKey.*must be a string/i,
      );
      expect(() => bad({ ...valid, group: 1 })(r)).toThrow(
        /group.*must be a string/i,
      );
      expect(() =>
        bad({
          id: 'n',
          category: 'c',
          title: 't',
          type: 'number',
          default: 1,
          unit: true,
        })(r),
      ).toThrow(/unit.*must be a string/i);
    });

    it('enum option labelKey 非字符串 → 抛', () => {
      const r = new SettingItemRegistry();
      expect(() =>
        bad({
          ...valid,
          enum: [{ value: 'light', label: 'L', labelKey: 42 }],
          default: 'light',
        })(r),
      ).toThrow(/labelKey must be a string/i);
    });
  });

  // 边界(E156):type='select' 语义上必须带非空 enum 数组(SettingItemRow 仅在 select && enum
  // 时渲染控件)。此前 enum 校验只在 enum !== undefined 时跑,select 无 enum 会注册出有标题无控件
  // 的死设置项。注册边界要求 select 必带非空 enum;enum 若提供必须是数组。
  describe('E156 · select 必须有非空 enum', () => {
    it('select 无 enum → 抛,不入 registry', () => {
      const r = new SettingItemRegistry();
      expect(() =>
        r.register({
          id: 'general.theme',
          category: 'general',
          title: '主题',
          type: 'select',
          default: 'dark',
        }),
      ).toThrow(/select type requires a non-empty enum/i);
      expect(r.getAll()).toEqual([]);
    });

    it('select 空 enum 数组 → 抛', () => {
      const r = new SettingItemRegistry();
      expect(() =>
        r.register({
          id: 'general.theme',
          category: 'general',
          title: '主题',
          type: 'select',
          default: 'dark',
          enum: [],
        }),
      ).toThrow(/select type requires a non-empty enum/i);
    });

    it('enum 非数组(对象/数字)→ 抛(不在 validate 内 TypeError 崩)', () => {
      const r = new SettingItemRegistry();
      const bad = (spec: unknown) => () => r.register(spec as never);
      expect(
        bad({ ...valid, enum: 123 }),
      ).toThrow(); // select + 非数组 → 命中 select requires enum 或 enum must be array
      expect(
        bad({
          id: 'n',
          category: 'c',
          title: 't',
          type: 'number',
          default: 1,
          enum: { a: 1 },
        }),
      ).toThrow(/enum must be an array/i);
    });

    it('select 带非空 enum 且 default ∈ enum → ok(回归)', () => {
      const r = new SettingItemRegistry();
      expect(() => r.register(valid)).not.toThrow();
      expect(r.getAll()).toHaveLength(1);
    });
  });
});
