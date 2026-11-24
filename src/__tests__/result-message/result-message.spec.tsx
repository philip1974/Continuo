// @vitest-environment jsdom
// BDD:带严重度的操作结果 live region。见同目录 README。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ResultMessage } from '../../lib/result-message';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
afterEach(() => cleanup());

describe('ResultMessage', () => {
  it('失败 → role=alert;成功 → role=status;文本与 className 原样', () => {
    const { getByRole, rerender } = render(
      <ResultMessage msg={{ text: 'boom', isError: true }} className="mt-2 text-xs" />,
    );
    expect(getByRole('alert').textContent).toBe('boom');
    expect(getByRole('alert').className).toBe('mt-2 text-xs');
    rerender(<ResultMessage msg={{ text: 'ok', isError: false }} className="mt-2 text-xs" />);
    expect(getByRole('status').textContent).toBe('ok');
  });

  it('msg 为 null → 不渲染', () => {
    const { container } = render(<ResultMessage msg={null} className="x" />);
    expect(container.innerHTML).toBe('');
  });
});

describe('接线守卫', () => {
  it.each(['plugins/settings/PluginsTabContent.tsx', 'marketplace/MarketplaceTab.tsx'])('%s', (rel) => {
    const src = readFileSync(path.join(SRC_ROOT, rel), 'utf-8');
    expect(src).toContain('<ResultMessage');
    expect(src).not.toContain("isError ? 'alert' : 'status'");
  });
});
