import type { LayoutMotionApi } from '../../electron/preload';

declare global {
  interface Window {
    api: LayoutMotionApi;
  }
}

export {};
