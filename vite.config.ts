import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { defineConfig, type Plugin } from 'vite';
import { manifestPlugin, type Target } from './build/make-manifest';

/**
 * One source -> two artifacts: dist/chrome and dist/firefox.
 * The target is chosen by the TARGET environment variable (see the scripts in
 * package.json).
 *
 * The differences between engines live ONLY in build/make-manifest.ts - the
 * code in src/ is shared and calls APIs through `browser.*` (CLAUDE.md 5).
 */

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const srcDir = resolve(rootDir, 'src');

const target: Target = process.env['TARGET'] === 'firefox' ? 'firefox' : 'chrome';

/**
 * The content script has to be a classic script - neither Chrome nor Firefox
 * loads content scripts as ESM. It therefore goes through esbuild separately as
 * an IIFE, while the rest (background, popup, offscreen) is built by Vite as
 * ESM.
 */
function contentScriptPlugin(outDir: string, isDev: boolean): Plugin {
  return {
    name: 'savely:content-script',
    apply: 'build',
    async closeBundle() {
      await esbuild({
        entryPoints: [resolve(srcDir, 'content/index.ts')],
        outfile: resolve(outDir, 'content.js'),
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: ['chrome109', 'firefox128'],
        sourcemap: isDev ? 'inline' : false,
        minify: !isDev,
        legalComments: 'none',
        alias: { '@': srcDir },
        define: {
          __TARGET__: JSON.stringify(target),
          __DEV__: JSON.stringify(isDev),
        },
      });
      console.log(`[savely] content.js -> dist/${target}`);
    },
  };
}

export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';
  const outDir = resolve(rootDir, 'dist', target);

  return {
    root: srcDir,
    // Icons and other static files: src/public/** -> dist/<target>/**
    publicDir: resolve(srcDir, 'public'),
    resolve: {
      alias: { '@': srcDir },
    },
    define: {
      __TARGET__: JSON.stringify(target),
      __DEV__: JSON.stringify(isDev),
    },
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: isDev ? 'inline' : false,
      target: ['chrome109', 'firefox128'],
      minify: !isDev,
      rollupOptions: {
        input: {
          background: resolve(srcDir, 'background/index.ts'),
          // The popup and the full list page; the path relative to `root`
          // lands in dist as ui/list/list.html.
          list: resolve(srcDir, 'ui/list/list.html'),
          reader: resolve(srcDir, 'ui/reader/index.html'),
          // The options page: moving data, backups, wiping the database.
          options: resolve(srcDir, 'ui/options/options.html'),
          // The offscreen document - used only on Chromium, but always built:
          // one artifact fewer to drift between targets.
          offscreen: resolve(srcDir, 'offscreen/offscreen.html'),
        },
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name][extname]',
        },
      },
    },
    plugins: [manifestPlugin({ rootDir, outDir, target }), contentScriptPlugin(outDir, isDev)],
  };
});
