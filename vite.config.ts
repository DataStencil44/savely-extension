import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { defineConfig, type Plugin } from 'vite';
import { manifestPlugin, type Target } from './build/make-manifest';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const srcDir = resolve(rootDir, 'src');

const target: Target = process.env['TARGET'] === 'firefox' ? 'firefox' : 'chrome';

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
          list: resolve(srcDir, 'ui/list/list.html'),
          reader: resolve(srcDir, 'ui/reader/index.html'),
          options: resolve(srcDir, 'ui/options/options.html'),
          ...(target === 'chrome' ? { offscreen: resolve(srcDir, 'offscreen/offscreen.html') } : {}),
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
