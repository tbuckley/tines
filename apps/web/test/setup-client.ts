// Setup for the `client` Vitest project (see vite.config.ts): the component
// tests run here, in jsdom.
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/svelte';

// Testing Library only registers its own teardown when Vitest's globals are
// on, and they are not: this project imports `describe`/`it`/`expect` like
// every other suite in the repo. Without this, each `render` leaves its
// container in the document and the next test's queries match twice.
afterEach(cleanup);
