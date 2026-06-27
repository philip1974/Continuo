import { describe, it, expect } from 'vitest';
import {
  parseInitialWorkspace,
  parseInitialWindowSeq,
  parseInitialFresh,
} from '../../lib/initial-workspace';

describe('parseInitialWorkspace', () => {
  it('?workspace=/abs/path → decoded 路径', () => {
    expect(parseInitialWorkspace('?workspace=/Users/me/proj')).toBe(
      '/Users/me/proj',
    );
  });

  it('URL-encoded 空格 / 斜杠正确解码', () => {
    expect(parseInitialWorkspace('?workspace=/a%20b/c')).toBe('/a b/c');
    expect(parseInitialWorkspace('?workspace=%2FUsers%2Fme')).toBe(
      '/Users/me',
    );
  });

  it('无 workspace 参数 → null', () => {
    expect(parseInitialWorkspace('?other=1')).toBeNull();
    expect(parseInitialWorkspace('')).toBeNull();
    expect(parseInitialWorkspace('?')).toBeNull();
  });

  it('?workspace= (空值)→ null', () => {
    expect(parseInitialWorkspace('?workspace=')).toBeNull();
  });

  it('?workspace=  (仅空白,decoded)→ null', () => {
    expect(parseInitialWorkspace('?workspace=%20%20')).toBeNull();
  });

  it('保留合法的前后空格路径(不 trim,符合 workspace.store 契约)', () => {
    // 文件系统允许尾随空格的目录名;trim 会损坏它。
    expect(parseInitialWorkspace('?workspace=/tmp/proj%20')).toBe('/tmp/proj ');
    expect(parseInitialWorkspace('?workspace=%20/lead')).toBe(' /lead');
  });

  it('与 ?popout=1 共存,各取所需', () => {
    expect(parseInitialWorkspace('?popout=1&workspace=/x')).toBe('/x');
    expect(parseInitialWorkspace('?workspace=/x&popout=1')).toBe('/x');
  });

  it('多个 workspace 参数 → 取第一个(URLSearchParams 默认行为)', () => {
    expect(parseInitialWorkspace('?workspace=/a&workspace=/b')).toBe('/a');
  });

  it('非 query 风格输入也容错(无 ? 前缀)', () => {
    expect(parseInitialWorkspace('workspace=/x')).toBe('/x');
  });
});

describe('parseInitialWindowSeq', () => {
  it('?windowSeq=N → 数字', () => {
    expect(parseInitialWindowSeq('?windowSeq=3')).toBe(3);
    expect(parseInitialWindowSeq('?windowSeq=0')).toBe(0);
  });

  it('无参数 → 默认 0(主窗)', () => {
    expect(parseInitialWindowSeq('')).toBe(0);
    expect(parseInitialWindowSeq('?other=1')).toBe(0);
  });

  it('非数字 / 负数 / 浮点 → 默认 0(防注入坏值)', () => {
    expect(parseInitialWindowSeq('?windowSeq=abc')).toBe(0);
    expect(parseInitialWindowSeq('?windowSeq=-1')).toBe(0);
    expect(parseInitialWindowSeq('?windowSeq=3.14')).toBe(0);
    expect(parseInitialWindowSeq('?windowSeq=')).toBe(0);
  });

  it('与 ?workspace 共存', () => {
    expect(parseInitialWindowSeq('?workspace=/x&windowSeq=2')).toBe(2);
  });

  // 边界(E8,E4/E7 同族):超大整数 > Number.MAX_SAFE_INTEGER 经 Number 会舍入,Number.isInteger
  // 仍为 true → 不可安全表示的 windowSeq 进持久化索引致精度碰撞。须 safe integer,否则回退 0。
  it('E8 超大整数(> MAX_SAFE_INTEGER)→ 回退 0(防精度碰撞)', () => {
    expect(parseInitialWindowSeq('?windowSeq=9007199254740993')).toBe(0); // 2^53+1
    expect(parseInitialWindowSeq('?windowSeq=99999999999999999999')).toBe(0);
  });

  it('E8 边界:正好 MAX_SAFE_INTEGER 仍接受', () => {
    expect(parseInitialWindowSeq('?windowSeq=9007199254740991')).toBe(
      9007199254740991,
    );
  });
});

// 边界(E193,外部输入长度上限族 E152/E179/E190/E191):启动 query 总长度上限(paramsOf 单一来源)。
// paramsOf 被三个 parse 函数在 renderer 启动早期各调一次 —— 超长 location.search 否则被 URLSearchParams
// 重复解析三次,早于字段级校验产生 CPU/内存峰值。超限 → 三处都当无 query(各自默认)。
describe('E193 · 启动 query 总长度上限', () => {
  // 64KiB 上限;造一个远超的 query(workspace 值塞 200K 字符)。
  const huge = `?workspace=${'/x'.repeat(120_000)}`; // ~240K 字符

  it('超长 query → parseInitialWorkspace 返 null(不解析)', () => {
    expect(huge.length).toBeGreaterThan(65536);
    expect(parseInitialWorkspace(huge)).toBeNull();
  });

  it('超长 query → parseInitialWindowSeq 返默认 0', () => {
    expect(parseInitialWindowSeq(`${huge}&windowSeq=3`)).toBe(0);
  });

  it('超长 query → parseInitialFresh 返 false', () => {
    expect(parseInitialFresh(`${huge}&fresh=1`)).toBe(false);
  });

  it('上限内的正常长 query → 照常解析(回归)', () => {
    // workspace 路径接近但不超 FS_PATH_MAX,query 总长 < 64KiB
    const longPath = `/Users/me/${'sub/'.repeat(1000)}proj`; // ~4K 字符
    const search = `?workspace=${longPath}&windowSeq=2&fresh=1`;
    expect(search.length).toBeLessThan(65536);
    expect(parseInitialWorkspace(search)).toBe(longPath);
    expect(parseInitialWindowSeq(search)).toBe(2);
    expect(parseInitialFresh(search)).toBe(true);
  });
});
