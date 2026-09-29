// Setup for the `client` Vitest project (see vite.config.ts): the component
// tests run here, in a headless Chromium.

// The app's stylesheet, loaded exactly as `routes/+layout.svelte` loads it.
// Without it the components mount unstyled, and every Tailwind class they
// rely on to lay out — the clamp's `max-h-(--clamp) overflow-hidden`, the
// pending button's `inline-grid` — does nothing, which would quietly turn
// the layout assertions below into assertions about nothing.
import '../src/app.css';

// No cleanup hook here: importing `render` from `vitest-browser-svelte`
// registers its own `beforeEach(cleanup)` (dist/index.mjs), and it calls
// Vitest's imported `beforeEach`, so it works without globals.
