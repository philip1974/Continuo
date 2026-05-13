// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import React, { type ComponentType } from 'react';
import { describe, expect, it } from 'vitest';
import { lazyPanel } from '../../lib/lazy-panel';

describe('tab split panes - lazyPanel props pass-through', () => {
  it('forwards Dockview panel props into the lazy panel component', async () => {
    type Props = { params: { sessionId: string; cwd: string } };
    const SeenProps: ComponentType<Props> = (props) =>
      React.createElement('output', { 'data-testid': 'seen' }, props.params.cwd);

    const factory = lazyPanel<Props>(SeenProps);
    render(
      React.createElement(
        React.Fragment,
        null,
        factory({ params: { sessionId: 'term-1', cwd: '/repo' } }),
      ),
    );

    expect((await screen.findByTestId('seen')).textContent).toBe('/repo');
  });
});
