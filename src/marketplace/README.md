# `src/marketplace/` — Plugin marketplace (Phase 1)

A read-only browser over a curated plugin index hosted on GitHub. Continuo does not run a marketplace backend — the index is a single `index.json` in a public repo, and reviews live in that repo's GitHub Discussions. It renders inside Settings → **Plugin Market**.

> The MVP is intentionally tiny: no server, no accounts, no payments. The index needs no auth. Reviews use GitHub's GraphQL API, which requires a token: start Continuo with a `GITHUB_TOKEN` environment variable (a fine-grained token with read-only access to public repositories, or a classic token with no scopes, is enough — don't grant write scopes), e.g. `GITHUB_TOKEN=… pnpm dev`. The token is never sent to the renderer, but like any environment variable it is inherited by the terminals Continuo starts (and the agents in them) and by plugin shell commands — use a token with no write access. Without it, reviews are simply unavailable (only previously cached data is shown).

## Data sources

| Source | Where | Cached how |
|---|---|---|
| Plugin index | `https://raw.githubusercontent.com/philip1974/continuo-plugins/main/index.json` | 1h in-memory + sessionStorage (`continuo:marketplace:index`). On fetch error, falls back to stale cache. |
| Per-plugin manifest | `https://raw.githubusercontent.com/<repo>/<branch>/manifest.json` | Not cached — re-fetched on every update check (only `id` / `name` / `version` are read). |
| Reviews | GitHub Discussions on the `continuo-plugins` repo, queried via GraphQL **by the main process** (`electron/main/services/marketplace-reviews.service.ts`) | 1h sessionStorage cache and aggregation in `reviews-fetcher.ts`; `reviews-store.ts` exposes it to React. |

`raw.githubusercontent.com` rate-limits unauthenticated traffic; the index is cached for 1h, while plugin manifests are re-fetched on every update check.

## Key files

| File | Role |
|---|---|
| `types.ts` | `MarketplaceEntry` (the index row shape) + URL builders `entryToGitUrl` / `entryToManifestUrl`. |
| `fetcher.ts` | `fetchMarketplaceIndex(forceRefresh?)` and `fetchPluginManifest(entry)`. Uses `getCachedFetch()` from `plugins/sandbox-sweep.ts` because the sandbox sweeper otherwise nukes `globalThis.fetch` from the renderer scope. |
| `filter.ts` | Pure-function search / tag filtering for the rendered list. |
| `semver.ts` | Comparator for "update available" badges. |
| `update-store.ts` | Tracks which installed plugins have a newer manifest version upstream. |
| `reviews-types.ts` | `Review` shape and `PluginAggregateRating` (count + avg + reviews[]). |
| `reviews-fetcher.ts` | Asks main (IPC) for the Discussions nodes, then parses / aggregates and caches them; never sees the token. |
| `reviews-parser.ts` | Extracts `pluginId` / `rating` from each Discussion's title + body schema. |
| `reviews-store.ts` | In-memory aggregate cache. |
| `MarketplaceTab.tsx` | The whole UI (one file: list + detail + install button + ratings). |

## `MarketplaceEntry` shape

```ts
interface MarketplaceEntry {
  id: string;            // reverse-DNS, matches plugin manifest.id
  name: string;
  description?: string;
  author: string;
  authorUrl?: string;
  repo: string;          // 'owner/name' on GitHub
  branch?: string;       // omitted → the repo's default branch (HEAD)
  tags?: readonly string[];
  verified?: boolean;    // true = official review pass, otherwise community
}
```

The index intentionally does **not** carry `version` — each plugin's own `manifest.json` is the version source; `fetchPluginManifest` reads it directly.

## Install flow

1. User picks an entry → click *Install*.
2. Renderer asks main (via `PLUGINS_CHANNELS.INSTALL_FROM_GIT`) to `git clone https://github.com/<entry.repo>.git` (with `--branch=<entry.branch>` when set, same source as the update check) into `${userData}/plugins/<entry.id>/`; main rejects with `PLUGIN_ID_MISMATCH` if the cloned `manifest.id` ≠ `entry.id`.
3. The plugin is installed **disabled**. After restarting Continuo, the user enables it in Settings → Plugins.
4. On enable, the renderer's `PluginManager` runs `ensureAuthorized` for the manifest's declared permissions (prompt → user grants/denies a subset), imports the plugin as ESM, runs `_activate()`, and collects the contribution-point disposables.

Uninstall = `_deactivate()` (LIFO disposes everything the plugin contributed) + remove the directory.

## Reviews subsystem

Each review is one GitHub Discussion in the `continuo-plugins` repo, following a documented body schema (the parser takes the plugin id from the body's plugin-id field, falling back to a leading `[id]` at the start of the title; the rating and body come from the schema fields). Aggregate rating is unweighted arithmetic mean; sort options include "most helpful" (by `THUMBS_UP` reaction count) and "newest". An author-account-age badge surfaces obviously-new accounts so users can weight reviews accordingly.

## Adding your plugin to the marketplace

Open a PR against [`philip1974/continuo-plugins`](https://github.com/philip1974/continuo-plugins) adding a row to `index.json` matching the `MarketplaceEntry` shape above. Set `verified: true` only if an official review has signed off (community PRs default to absent / `false`).

## See also

- `src/plugins/README.md` — what the installed plugin looks like at runtime
- `src/plugins/sandbox-sweep.ts` — why `fetcher.ts` has to use `getCachedFetch()`
