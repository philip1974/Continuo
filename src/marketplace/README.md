# `src/marketplace/` — Plugin marketplace (Phase 1)

A read-only browser over a curated plugin index hosted on GitHub. Continuo does not run a marketplace backend — the index is a single `index.json` in a public repo, and reviews live in that repo's GitHub Discussions. The renderer fetches both, caches them, and renders inside the Settings → Marketplace tab.

> The MVP is intentionally tiny: no auth, no server, no payments, no licenses. Discoverability + verifiability, that's it.

## Data sources

| Source | Where | Cached how |
|---|---|---|
| Plugin index | `https://raw.githubusercontent.com/philip1974/continuo-plugins/main/index.json` | 1h in-memory + sessionStorage (`continuo:marketplace:index`). On fetch error, falls back to stale cache. |
| Per-plugin manifest | `https://raw.githubusercontent.com/<repo>/<branch>/manifest.json` | Not cached — re-fetched on every update check (the version is the only thing we read). |
| Reviews | GitHub Discussions on the `continuo-plugins` repo, queried via GraphQL | Per-session memo in `reviews-store.ts`. |

GitHub's raw endpoint is rate-limited to 60 req/hr for unauthenticated traffic; the 1h cache keeps a single user well under that.

## Key files

| File | Role |
|---|---|
| `types.ts` | `MarketplaceEntry` (the index row shape) + URL builders `entryToGitUrl` / `entryToManifestUrl`. |
| `fetcher.ts` | `fetchMarketplaceIndex(forceRefresh?)` and `fetchPluginManifest(entry)`. Uses `getCachedFetch()` from `plugins/sandbox-sweep.ts` because the sandbox sweeper otherwise nukes `globalThis.fetch` from the renderer scope. |
| `filter.ts` | Pure-function search / tag / verified filtering for the rendered list. |
| `semver.ts` | Comparator for "update available" badges. |
| `update-store.ts` | Tracks which installed plugins have a newer manifest version upstream. |
| `reviews-types.ts` | `Review` shape and `PluginAggregateRating` (count + avg + reviews[]). |
| `reviews-fetcher.ts` | GraphQL call against the `continuo-plugins` repo's Discussions. |
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
  branch?: string;       // default 'main'
  tags?: readonly string[];
  verified?: boolean;    // true = official review pass, otherwise community
}
```

The index intentionally does **not** carry `version` — each plugin's own `manifest.json` is the version source; `fetchPluginManifest` reads it directly.

## Install flow

1. User picks an entry → click *Install*.
2. Renderer asks main (via `PLUGINS_CHANNELS.INSTALL_FROM_GIT`) to `git clone https://github.com/<entry.repo>.git` into `${userData}/plugins/<entry.id>/`.
3. Main parses the manifest, runs `ensureAuthorized` for declared permissions (prompt → user grants/denies subset).
4. Plugin gets imported as ESM (see `ADR-Plugin-2-esm-not-cjs.md`), `_activate()` runs, contribution-point disposables collect.

Uninstall = `_deactivate()` (LIFO disposes everything the plugin contributed) + remove the directory.

## Reviews subsystem

Each review is one GitHub Discussion in the `continuo-plugins` repo, following a documented body schema (the parser pulls the plugin id from the title's first `[brackets]` and the rating + body from the schema fields). Aggregate rating is unweighted arithmetic mean; sort options include "most helpful" (by `THUMBS_UP` reaction count) and "newest". An author-account-age badge surfaces obviously-new accounts so users can weight reviews accordingly.

## Adding your plugin to the marketplace

Open a PR against [`philip1974/continuo-plugins`](https://github.com/philip1974/continuo-plugins) adding a row to `index.json` matching the `MarketplaceEntry` shape above. Set `verified: true` only if an official review has signed off (community PRs default to absent / `false`).

## See also

- `src/plugins/README.md` — what the installed plugin looks like at runtime
- `src/plugins/sandbox-sweep.ts` — why `fetcher.ts` has to use `getCachedFetch()`
- ContinuoWiki tutorial 11 — design history / why GitHub-as-backend
