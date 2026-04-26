/**
 * Local test harness for the analyze + synthesize pipeline.
 *
 * Goal: iterate on prompts and refusal handling against real captures
 * WITHOUT redeploying Cloud Run.
 *
 * Skips GCP Vision entirely — we pass already-extracted OCR text via
 * `--ocr` (one per image, in order) so the harness doesn't need GCP creds.
 *
 * Required env:
 *   OPENROUTER_API_KEY    (same value as the Cloud Run secret)
 * Optional env:
 *   OPENROUTER_MODEL      (default: openai/gpt-4o-mini)
 *
 * Usage:
 *   tsx scripts/test-analyze.ts \
 *     --ocr=path/to/image1.ocr.txt path/to/image1.png \
 *     [--ocr=path/to/image2.ocr.txt path/to/image2.png ...] \
 *     [--out=path/to/output.txt]
 *
 * If --ocr is NOT supplied, the harness will still try to call the analyze
 * function, which will fall back to GCP Vision (and fail locally without
 * credentials).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { argv, exit, env } from 'node:process';

import { analyzeImage } from '../src/services/analyze.js';
import {
  synthesizeAcrossImages,
  type SynthesizeItem,
} from '../src/services/synthesize.js';

interface ParsedArgs {
  inputs: Array<{ image: string; ocr?: string }>;
  outPath?: string;
}

function parseArgs(rawArgs: string[]): ParsedArgs {
  const inputs: Array<{ image: string; ocr?: string }> = [];
  let pendingOcr: string | undefined;
  let outPath: string | undefined;

  for (const arg of rawArgs) {
    if (arg.startsWith('--ocr=')) {
      pendingOcr = arg.slice('--ocr='.length);
      continue;
    }
    if (arg.startsWith('--out=')) {
      outPath = arg.slice('--out='.length);
      continue;
    }
    if (arg.startsWith('--')) continue;
    inputs.push({ image: arg, ocr: pendingOcr });
    pendingOcr = undefined;
  }
  return { inputs, outPath };
}

function mimeFromPath(p: string): string {
  const ext = extname(p).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function bar(label: string): void {
  // eslint-disable-next-line no-console
  console.log(`\n${'='.repeat(72)}\n${label}\n${'='.repeat(72)}`);
}

async function main(): Promise<void> {
  const { inputs, outPath } = parseArgs(argv.slice(2));

  if (inputs.length === 0) {
    // eslint-disable-next-line no-console
    console.error(
      'Usage: tsx scripts/test-analyze.ts [--ocr=ocr.txt image.png ...] [--out=out.txt]',
    );
    exit(2);
  }

  if (!env.OPENROUTER_API_KEY) {
    // eslint-disable-next-line no-console
    console.error(
      'OPENROUTER_API_KEY env var is required. Get it from GCP:\n' +
        '  export OPENROUTER_API_KEY=$(gcloud secrets versions access latest \\\n' +
        '    --secret=voiceido-openrouter-key --project=ocr-project-1770234385)',
    );
    exit(2);
  }

  const items: SynthesizeItem[] = [];
  const transcript: string[] = [];

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!;
    const imagePath = resolve(input.image);
    const ocrPath = input.ocr ? resolve(input.ocr) : null;

    bar(`Image ${i + 1} / ${inputs.length} — ${basename(imagePath)}`);
    // eslint-disable-next-line no-console
    console.log(`  image: ${imagePath}`);
    // eslint-disable-next-line no-console
    console.log(`  ocr:   ${ocrPath ?? '(none — will call GCP Vision)'}`);

    const buffer = await readFile(imagePath);
    const ocrText = ocrPath ? await readFile(ocrPath, 'utf8') : undefined;
    const t0 = Date.now();
    const analysis = await analyzeImage(buffer, mimeFromPath(imagePath), {
      precomputedOcr: ocrText,
    });
    const dt = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`\n  analysis: ${analysis.length} chars in ${dt} ms\n`);
    // eslint-disable-next-line no-console
    console.log(analysis);

    items.push({
      index: i + 1,
      ocr: ocrText ?? '',
      analysis,
    });
    transcript.push(`--- Image ${i + 1} of ${inputs.length} ---\n\n${analysis}`);
  }

  let synthesis = '';
  if (items.length > 1) {
    bar('Synthesis (across all images)');
    const t0 = Date.now();
    synthesis = await synthesizeAcrossImages(items);
    const dt = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`\n  synthesis: ${synthesis.length} chars in ${dt} ms\n`);
    // eslint-disable-next-line no-console
    console.log(synthesis);
  }

  const final =
    items.length > 1
      ? [
          '===== UNIFIED ANALYSIS (essay across all images) =====',
          '',
          synthesis,
          '',
          '===== Per-Image Detail =====',
          '',
          transcript.join('\n\n'),
        ].join('\n')
      : transcript.join('\n\n');

  const finalOut = outPath
    ? resolve(outPath)
    : resolve(
        dirname(inputs[0]!.image),
        `${basename(inputs[0]!.image, extname(inputs[0]!.image))}.local-analyze.txt`,
      );

  await writeFile(finalOut, final, 'utf8');
  bar(`Wrote ${finalOut}  (${final.length} chars)`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  exit(1);
});
