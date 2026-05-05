import type { ContinuoApi } from '../../electron/preload';

declare global {
  interface Window {
    api: ContinuoApi;
  }
}

export {};
