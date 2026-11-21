import type { Page } from '@playwright/test';

export async function dispatchModKey(
  window: Page,
  key: string,
  options: { shift?: boolean } = {},
): Promise<void> {
  await window.evaluate(
    ({ key: eventKey, shift }) => {
      const isMac = navigator.platform.toLowerCase().includes('mac');
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: eventKey,
          ctrlKey: !isMac,
          metaKey: isMac,
          shiftKey: shift,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { key, shift: options.shift ?? false },
  );
}
