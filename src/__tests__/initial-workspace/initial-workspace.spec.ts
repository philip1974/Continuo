import { describe, it, expect } from 'vitest';
import { parseInitialWorkspace } from '../../lib/initial-workspace';

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
