// @vitest-environment jsdom
// 安全(L2):图表源码里的 %%{init}%% 指令不能借 fontFamily / altFontFamily 往生成的 CSS 里注入别的属性。
// mermaid 对这两个键只做花括号配对检查(sanitizeCss),值原样拼进
// `:root { --mermaid-font-family: ${fontFamily}}` 与外层 div 的 style → `x; background:url(https://…)`
// 成为一条独立声明,打开不受信文档即发外部请求。
//
// 这里用真实 mermaid 的配置/指令处理(initialize 用本模块传入的真实配置,指令经真实 parse 合入),
// 只把 render 换成「解析后读出生效配置」—— jsdom 没有 SVG 布局,真实渲染由 e2e 覆盖。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const effective = vi.hoisted(() => ({ configs: [] as Record<string, unknown>[] }));

vi.mock('mermaid', async () => {
  const actual = (await vi.importActual<typeof import('mermaid')>('mermaid')).default;
  return {
    default: {
      initialize: (cfg: Record<string, unknown>) => actual.initialize(cfg),
      render: async (id: string, code: string) => {
        await actual.parse(code);
        effective.configs.push(actual.mermaidAPI.getConfig() as Record<string, unknown>);
        return { svg: `<svg id="${id}"></svg>` };
      },
    },
  };
});

async function renderAndReadConfig(code: string): Promise<Record<string, unknown>> {
  vi.resetModules();
  const { renderMermaidPreview } = await import('../../panels/Editor/mermaid-preview');
  const apply = vi.fn();
  renderMermaidPreview('mermaid', code, apply);
  await vi.waitFor(() => expect(apply).toHaveBeenCalled());
  return effective.configs.at(-1)!;
}

beforeEach(() => {
  effective.configs = [];
});

describe('L2 · mermaid %%{init}%% 指令不能经字体键注入 CSS', () => {
  it('fontFamily / altFontFamily 指令被忽略,生效值不含攻击者的 background / url(', async () => {
    const cfg = await renderAndReadConfig(
      '%%{init: {"fontFamily":"x; background:url(https://evil.example/ff)",' +
        ' "altFontFamily":"y; background:url(https://evil.example/alt)"}}%%\nflowchart LR\n  A-->B',
    );
    // mermaid 会把指令里的 fontFamily 同步进 themeVariables.fontFamily(绕过 themeVariables 的字符集检查),
    // 三处都进 CSS,都必须不受指令影响。
    const themeVariables = (cfg.themeVariables ?? {}) as Record<string, unknown>;
    for (const value of [cfg.fontFamily, cfg.altFontFamily, themeVariables.fontFamily]) {
      expect(String(value ?? '')).not.toMatch(/evil\.example|background|url\(/);
    }
  });

  it('不带指令时 fontFamily 仍是 mermaid 默认值(回归)', async () => {
    const cfg = await renderAndReadConfig('flowchart LR\n  A-->B');
    expect(String(cfg.fontFamily)).toContain('"trebuchet ms", verdana, arial, sans-serif');
  });
});
