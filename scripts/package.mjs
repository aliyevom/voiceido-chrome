#!/usr/bin/env node
// Zips dist/ into release/full-page-voiceido-<version>.zip for Web Store upload.

import { mkdir, readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dist = resolve(root, 'dist');
const releaseDir = resolve(root, 'release');

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
await mkdir(releaseDir, { recursive: true });

const zipPath = resolve(releaseDir, `full-page-voiceido-${pkg.version}.zip`);

// Use system zip — Chrome Web Store accepts standard ZIPs and avoids
// adding an archiver dependency just for packaging.
execSync(`cd "${dist}" && zip -r "${zipPath}" .`, { stdio: 'inherit' });
console.log(`[package] wrote ${zipPath}`);
