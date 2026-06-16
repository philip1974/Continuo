export const IFRAME_STATES = [
  'blob-loaded-ok',
  'frame-blob-blocked',
  'iframe-throw',
  'csp-blocks-inline',
] as const;

export type WorkerVerdict =
  | { ok: true; ms: number; cspContent: string | null }
  | {
      ok: false;
      error: 'CSP-block' | 'timeout' | 'iframe-throw' | string;
      cspContent: string | null;
      ms?: number;
    };

export type IframeVerdict =
  | { state: 'blob-loaded-ok'; ms: number }
  | { state: 'frame-blob-blocked'; cspContent: string | null }
  | { state: 'iframe-throw'; error: string }
  | { state: 'csp-blocks-inline'; cspContent: string | null };

export type SabVerdict =
  | { state: 'ok'; ms: number; crossOriginIsolated: boolean }
  | { state: 'worker-create-fail'; blockedBy: 'worker'; crossOriginIsolated: boolean }
  | { state: 'sab-construct-fail'; error: string; crossOriginIsolated: boolean }
  | { state: 'sab-postmessage-fail'; error: string; crossOriginIsolated: boolean }
  | { state: 'atomics-wait-fail'; error: string; crossOriginIsolated: boolean };

export interface SpikeResult {
  worker: WorkerVerdict;
  iframe: IframeVerdict;
  iframeInline?: IframeVerdict;
  sab: SabVerdict;
  meta: {
    appIsPackaged: boolean | null;
    locationProtocol: string;
    cspContent: string | null;
    timestamp: string;
  };
}

