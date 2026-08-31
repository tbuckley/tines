# Tines

pnpm monorepo (Node >= 20). `apps/web` is a SvelteKit (Svelte 5) app deployed to Cloudflare Workers with D1/Kysely; `packages/cli` and `packages/shared` are the CLI and shared code.

## Commands

- `pnpm dev` — run the web app
- `pnpm build` — build `apps/web` and `packages/cli` (`@tines/shared` has no build step; it is consumed as TypeScript source and bundled by both)
- `pnpm check` — typecheck/svelte-check all packages
- `pnpm test` — vitest unit tests
- `pnpm test:e2e` — Playwright e2e suite (boots the built worker under `wrangler dev` with a seeded local D1; see `apps/web/e2e/`). Not run by CI, which stops at `pnpm test`.
- `pnpm cli <command>` — run the CLI from source against `$TINES_API_URL` (default `http://localhost:5173`)

## Icons

Use Tabler Icons via `@tabler/icons-svelte`, and always import icons with deep imports rather than the package barrel:

```svelte
<script lang="ts">
	import IconHeart from '@tabler/icons-svelte/icons/heart';
</script>

<IconHeart size={20} stroke={1.5} />
```

Do not use barrel imports (`import { IconHeart } from '@tabler/icons-svelte'`): the barrel re-exports every icon in the package (~6,200 in 3.46.0) plus their aliases, which makes Vite dev-server startup and HMR noticeably slower. Deep import paths are the icon name in kebab-case (e.g. `icons/arrow-left`, `icons/heart-filled`), each exporting the component as its default.
