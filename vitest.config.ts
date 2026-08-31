import { createRequire } from 'node:module';
import { defineConfig, type Plugin } from 'vitest/config';
import solidPlugin from 'vite-plugin-solid';

const solidRefreshRuntime = createRequire(import.meta.url).resolve('solid-refresh/dist/solid-refresh.mjs');

/**
 * Resolve `vite-plugin-solid`'s HMR runtime to a real file instead of its virtual id.
 *
 * The plugin serves that runtime from the id `/@solid-refresh`, and resolves the bare
 * `solid-refresh` specifier to it. Vitest's node runner turns a module id into a URL, so it
 * becomes `file:///@solid-refresh` — a valid absolute path on POSIX, and not one on Windows,
 * which needs a drive letter:
 *
 *     fileURLToPath('file:///@solid-refresh')
 *     TypeError: File URL path must be absolute
 *
 * The three `tests/solid/*` suites then fail at import and collect zero tests, so a Windows run
 * reports ~35 fewer tests than CI with no failure to account for the difference — the kind of
 * gap that hides a real one.
 *
 * This has to be a `pre` plugin rather than a `resolve.alias` entry: the id is itself produced
 * by the plugin's own alias, and Vite does not re-run aliasing on an alias result, so an entry
 * for `/@solid-refresh` never gets a chance. Resolving it here lands ahead of the plugin's own
 * `resolveId`, which would otherwise claim the id and hand back the unusable form.
 *
 * The file is the same module the plugin would have served inline, so this changes what the
 * runner is handed, not what it runs. Applied unconditionally rather than behind a `win32`
 * check so CI exercises the same resolution Windows does, and a break fails on Linux too
 * instead of only off-CI.
 */
function solidRefreshRealPath(): Plugin {
  return {
    name: 'solid-refresh-real-path',
    enforce: 'pre',
    resolveId(id) {
      return id === '/@solid-refresh' ? solidRefreshRuntime : null;
    },
  };
}

export default defineConfig({
  plugins: [solidRefreshRealPath(), solidPlugin()],
  test: {
    environment: 'happy-dom',
  },
  resolve: {
    conditions: ['development', 'browser'],
  },
});
