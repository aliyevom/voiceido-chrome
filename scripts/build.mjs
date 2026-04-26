#!/usr/bin/env node
// Bundles each Chrome-extension entry with esbuild and mirrors static assets
// from public/ into dist/. Service worker + offscreen ship as ES modules so
// they can `import` shared utility code; the content script ships as IIFE so
// it does not pollute the host page's module graph.

import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outDir = resolve(root, 'dist');
const publicDir = resolve(root, 'public');
const watch = process.argv.includes('--watch');
const isProd = process.env.NODE_ENV === 'production' || !watch;

/**
 * Shared esbuild options. Output ES modules where possible so we can keep
 * imports across our background / offscreen / popup code.
 */
const sharedOptions = {
  bundle: true,
  target: 'chrome120',
  platform: 'browser',
  sourcemap: !isProd,
  minify: isProd,
  legalComments: 'none',
  logLevel: 'info',
};

/** @type {esbuild.BuildOptions[]} */
const builds = [
  {
    ...sharedOptions,
    entryPoints: { service_worker: 'src/background/service_worker.ts' },
    outdir: `${outDir}/background`,
    format: 'esm',
  },
  {
    ...sharedOptions,
    entryPoints: { offscreen: 'src/offscreen/offscreen.ts' },
    outdir: `${outDir}/offscreen`,
    format: 'esm',
  },
  {
    ...sharedOptions,
    entryPoints: { popup: 'src/popup/popup.ts' },
    outdir: `${outDir}/popup`,
    format: 'esm',
  },
  {
    ...sharedOptions,
    entryPoints: { capture: 'src/capture/capture.ts' },
    outdir: `${outDir}/capture`,
    format: 'esm',
  },
  {
    // Content scripts cannot use ES module imports when injected via
    // `content_scripts` declaration. Bundle as IIFE.
    ...sharedOptions,
    entryPoints: { page_capture: 'src/content/page_capture.ts' },
    outdir: `${outDir}/content`,
    format: 'iife',
  },
];

async function copyStaticAssets() {
  await mkdir(outDir, { recursive: true });
  if (existsSync(publicDir)) {
    await cp(publicDir, outDir, { recursive: true });
  }
  // Copy the popup + offscreen + capture HTML alongside their JS bundles
  await cp('src/popup/popup.html', `${outDir}/popup/popup.html`);
  await cp('src/popup/popup.css', `${outDir}/popup/popup.css`);
  await cp('src/offscreen/offscreen.html', `${outDir}/offscreen/offscreen.html`);
  await cp('src/capture/capture.html', `${outDir}/capture/capture.html`);
  await cp('src/capture/capture.css', `${outDir}/capture/capture.css`);
}

async function buildOnce() {
  await rm(outDir, { recursive: true, force: true });
  await copyStaticAssets();
  await Promise.all(builds.map((opts) => esbuild.build(opts)));
  console.log(`[build] dist ready (${isProd ? 'production' : 'development'})`);
}

async function buildWatch() {
  await rm(outDir, { recursive: true, force: true });
  await copyStaticAssets();
  const ctxs = await Promise.all(builds.map((opts) => esbuild.context(opts)));
  await Promise.all(ctxs.map((ctx) => ctx.watch()));
  console.log('[build] watching for changes…');
}

if (watch) {
  await buildWatch();
} else {
  await buildOnce();
}
