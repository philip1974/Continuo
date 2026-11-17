// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { t } from '../../i18n';

const coApiMock = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(async () => ({ ok: true as const, data: undefined })),
  onDirChanged: vi.fn(() => vi.fn()),
  openExternal: vi.fn(),
}));

vi.mock('../../panels/Editor/CodeEditor', () => ({
  CodeEditor: ({ value }: { value: string }) => (
    <div data-testid="code-editor">{value}</div>
  ),
}));

vi.mock('../../panels/Editor/MilkdownEditor', () => ({
  MilkdownEditor: ({
    defaultValue,
    readonly,
  }: {
    defaultValue: string;
    readonly?: boolean;
  }) => (
    <div data-testid="milkdown-editor" data-readonly={String(!!readonly)}>
      {defaultValue}
    </div>
  ),
}));

vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

vi.mock('../../lib/co-api', () => ({
  coApi: {
    fs: {
      readFile: coApiMock.readFile,
      writeFile: coApiMock.writeFile,
      onDirChanged: coApiMock.onDirChanged,
    },
    shell: {
      openExternal: coApiMock.openExternal,
    },
  },
}));

vi.mock('../../notifications/notify', () => ({
  notify: { error: vi.fn() },
}));

const unsafeContent = '---\nid: demo\n---\n# Title\n';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useEditorStore.setState({
    tabs: [
      {
        id: '/work/flow.md',
        filePath: '/work/flow.md',
        content: unsafeContent,
        originalContent: unsafeContent,
        dirty: false,
      },
    ],
    activeTabId: '/work/flow.md',
    mode: 'edit',
  });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('EditorPanel unsafe markdown routing', () => {
  it('renders CodeEditor and banner even when requested mode is edit', () => {
    const { container } = render(<EditorPanel />);

    expect(screen.getByTestId('code-editor')).not.toBeNull();
    expect(screen.queryByTestId('milkdown-editor')).toBeNull();
    expect(container.textContent).toContain(
      t('panels.editor.milkdownUnsafe.banner'),
    );
  });

  it('does not write changed bytes after open and five seconds of auto-save time', async () => {
    render(<EditorPanel />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(coApiMock.writeFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().tabs[0]?.content).toBe(unsafeContent);
    expect(useEditorStore.getState().tabs[0]?.originalContent).toBe(
      unsafeContent,
    );
  });

  it('renders read-only Milkdown without banner in preview mode, frontmatter as yaml block', () => {
    useEditorStore.setState({ mode: 'preview' });
    const { container } = render(<EditorPanel />);

    const milkdown = screen.getByTestId('milkdown-editor');
    expect(milkdown.getAttribute('data-readonly')).toBe('true');
    expect(milkdown.textContent).toBe('```yaml\nid: demo\n```\n\n# Title\n');
    expect(screen.queryByTestId('code-editor')).toBeNull();
    expect(container.textContent).not.toContain(
      t('panels.editor.milkdownUnsafe.banner'),
    );
    expect(useEditorStore.getState().tabs[0]?.content).toBe(unsafeContent);
  });

  it('opts only the confirmed tab into Milkdown edit via "switch anyway"', () => {
    const other = '/work/other.md';
    useEditorStore.setState((s) => ({
      mode: 'source',
      tabs: [
        ...s.tabs,
        {
          id: other,
          filePath: other,
          content: unsafeContent,
          originalContent: unsafeContent,
          dirty: false,
        },
      ],
    }));
    render(<EditorPanel />);

    fireEvent.click(
      screen.getByRole('radio', { name: t('panels.editor.mode.edit') }),
    );
    expect(screen.queryByTestId('milkdown-editor')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', {
        name: t('panels.editor.milkdownUnsafe.switchAnyway'),
      }),
    );

    const milkdown = screen.getByTestId('milkdown-editor');
    expect(milkdown.getAttribute('data-readonly')).toBe('false');
    expect(milkdown.textContent).toBe(unsafeContent);

    act(() => {
      useEditorStore.getState().switchTab(other);
    });
    expect(screen.queryByTestId('milkdown-editor')).toBeNull();
    expect(screen.getByTestId('code-editor')).not.toBeNull();
  });
});
