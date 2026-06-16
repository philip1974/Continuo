import type { Event } from 'electron';

export type SpikeReason = 'dev' | 'env-opt-in' | 'packaged-blocked' | 'env-missing';

export interface SpikeAllowedInput {
  url: string;
  argv: string[];
  packaged: boolean;
}

export interface SpikeAllowedResult {
  allowed: boolean;
  reason: SpikeReason;
}

export interface RendererQueryInput {
  workspace?: string;
  windowSeq?: string;
  fresh?: boolean;
  spike?: string;
}

export function spikeAllowed(input: SpikeAllowedInput): SpikeAllowedResult {
  const { url, argv, packaged } = input;
  const envOptIn =
    argv.some((arg) => arg.startsWith('CONTINUO_SPIKE=1') || arg === '--spike') ||
    process.env.CONTINUO_SPIKE === '1';
  const hasSpikeQuery = /[?&]spike=/.test(url);

  if (!packaged) return { allowed: true, reason: 'dev' };
  if (envOptIn) return { allowed: true, reason: 'env-opt-in' };
  if (hasSpikeQuery) return { allowed: false, reason: 'packaged-blocked' };
  return { allowed: false, reason: 'env-missing' };
}

export function buildRendererQuery(input: RendererQueryInput): Record<string, string> {
  const query: Record<string, string> = {};
  if (input.workspace) query.workspace = input.workspace;
  if (input.windowSeq) query.windowSeq = input.windowSeq;
  if (input.fresh) query.fresh = '1';
  if (input.spike) query.spike = input.spike;
  return query;
}

export function stripSpikeQuery(
  query: Record<string, string>,
  allowed: boolean,
): Record<string, string> {
  if (allowed) return { ...query };

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (key === 'spike' || key.startsWith('spike')) continue;
    out[key] = value;
  }
  return out;
}

export function guardNav(
  event: { preventDefault: () => void },
  url: string,
  packaged: boolean,
): SpikeAllowedResult {
  const result = spikeAllowed({ url, argv: process.argv, packaged });
  if (!result.allowed) {
    event.preventDefault();
    console.warn('[spike-gate] guardNav blocked', { url, reason: result.reason });
  }
  return result;
}

export function guardOpen(
  details: { url: string },
  packaged: boolean,
): { action: 'deny' | 'allow' } {
  const result = spikeAllowed({ url: details.url, argv: process.argv, packaged });
  if (!result.allowed) {
    console.warn('[spike-gate] guardOpen denied', { url: details.url, reason: result.reason });
    return { action: 'deny' };
  }
  return { action: 'allow' };
}

export function installSpikeGate(
  contents: { on: (event: string, handler: (event: Event, url: string) => void) => void },
  packaged: boolean,
): () => void {
  const handler = (event: Event, url: string) => {
    guardNav(event, url, packaged);
  };

  contents.on('will-navigate', handler);
  contents.on('will-frame-navigate', handler);

  return () => {
    // Electron WebContents listener cleanup is wired by the owning lifecycle.
  };
}

