// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import {
  GeneralIcon,
  EditorIcon,
  ExplorerIcon,
  TerminalIcon,
  KeybindingsIcon,
  PluginsIcon,
  MarketplaceIcon,
} from '../../plugins/settings/tab-icons';

afterEach(() => cleanup());

const ICONS: ReadonlyArray<readonly [string, () => React.ReactElement]> = [
  ['General', GeneralIcon],
  ['Editor', EditorIcon],
  ['Explorer', ExplorerIcon],
  ['Terminal', TerminalIcon],
  ['Keybindings', KeybindingsIcon],
  ['Plugins', PluginsIcon],
  ['Marketplace', MarketplaceIcon],
];

describe('tab-icons', () => {
  it.each(ICONS)('%s: 渲染 svg + 标准属性 + 至少一个子元素', (_, Icon) => {
    const { container } = render(<Icon />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('width')).toBe('14');
    expect(svg!.getAttribute('height')).toBe('14');
    expect(svg!.getAttribute('viewBox')).toBe('0 0 16 16');
    expect(svg!.getAttribute('fill')).toBe('none');
    expect(svg!.getAttribute('stroke')).toBe('currentColor');
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
    expect(svg!.children.length).toBeGreaterThan(0);
  });
});
