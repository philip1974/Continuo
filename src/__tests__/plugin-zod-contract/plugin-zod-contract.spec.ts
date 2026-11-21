import { describe, expect, it } from 'vitest';
import { pluginZod as z } from '@/plugins/plugin-zod';

describe('插件 co.z 保持 zod 3 API', () => {
  it('z.unknown() 字段缺失仍通过', () => {
    expect(z.object({ x: z.unknown() }).safeParse({}).success).toBe(true);
  });

  it('ZodError 有 .errors 数组', () => {
    const r = z.string().safeParse(1);
    expect(r.success).toBe(false);
    if (!r.success) expect(Array.isArray(r.error.errors)).toBe(true);
  });

  it('required_error 自定义文案生效', () => {
    const r = z.object({ name: z.string({ required_error: 'MYMSG' }) }).safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe('MYMSG');
  });
});
