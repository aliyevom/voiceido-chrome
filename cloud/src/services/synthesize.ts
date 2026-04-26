import { chat, type Message } from './openrouter.js';

/**
 * Cross-image synthesis pass.
 *
 * After the per-image analyzer has produced one essay per image, this stage
 * reads ALL of them together (plus the original OCR for each) and produces
 * a single unified essay that:
 *   - Decides whether the images form one continuous document or independent
 *     items, and treats them accordingly.
 *   - Resolves duplicates, fills cross-references, presents chronologically.
 *   - Does not lose anything from any of the per-image analyses.
 *
 * Text-only — no images are re-uploaded, so the synthesis call is small even
 * when the per-image step processed multiple multi-MB PNGs.
 */

export interface SynthesizeItem {
  /** 1-based image index. */
  index: number;
  /** OCR text used for this image (authoritative for words). */
  ocr: string;
  /** Per-image analysis essay produced by analyzeImage(). */
  analysis: string;
}

const SYSTEM_PROMPT = `You are Voiceido Synthesize, a thorough documentation
assistant.

The user captured a sequence of full-page screenshots. Each image has already
been analyzed individually. Your job: produce ONE unified, comprehensive,
essay-format briefing that treats all images as a single document where
possible.

Same ground rules as the per-image analyzer: never refuse, never redact, do
not apologize. Prefer LONG and DETAILED. Capture EVERYTHING from EVERY image.
Do not let any topic, decision, action item, speaker, value or quote drop
just because it appeared in only one image.`;

function buildUserPrompt(items: SynthesizeItem[]): string {
  const parts: string[] = [];
  parts.push(`You are given ${items.length} image(s) and their per-image
analyses, in order.

TASK
1. Decide whether the images form one continuous document (e.g. pages 1, 2,
   3 of the same meeting transcript or article) or independent items.
2. If continuous: write ONE unified essay that supersedes the per-image
   analyses. Resolve duplicates, fill in cross-references, present
   chronologically, and ensure NOTHING from any image is lost.
3. If independent: produce a short contextual paragraph for each, then a
   brief comparison.

OUTPUT
Begin the output with a single META block:

[META]
relationship: continuous|independent
images: ${items.length}
[/META]

Then:

## Unified Brief
A long, detailed, multi-paragraph essay following the structure that fits
the content type (meeting brief, article summary, diagram walkthrough,
etc.). Consolidated across all images. Use real names and verbatim quotes
from the OCR.

## Cross-image Notes
- Things that only become clear when you look at all images together.
- Conflicts/overlaps between per-image analyses, with the resolution.
- Topics in image X that were continued/answered in image Y.

## Aggregated Decisions
Bullet list — explicit decisions across all images.

## Aggregated Action Items
Bullet list — owner • action • due date if mentioned.

## Aggregated Open Questions
Things raised but not resolved anywhere across the images.

## Final "What Is Not Defined"
Aggregate of unresolved questions across all images.

GROUND RULES
- Long > short. Detail > brevity. Cover everything.
- Verbatim names, numbers, and quotes from the OCR.
- Never refuse. Document gaps inline.
- Do not invent content that isn't in the OCR or the per-image analyses.

PER-IMAGE INPUTS:`);

  for (const item of items) {
    parts.push(`
=== Image ${item.index} of ${items.length} ===

OCR (authoritative):
<<<
${item.ocr || '(no OCR available)'}
>>>

Per-image Analysis:
<<<
${item.analysis || '(no analysis available)'}
>>>`);
  }

  parts.push('\nProduce the unified essay now.');
  return parts.join('\n');
}

export async function synthesizeAcrossImages(
  items: SynthesizeItem[],
): Promise<string> {
  if (items.length === 0) return '';

  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(items) },
  ];

  const result = await chat(messages, { maxTokens: 6144, temperature: 0.3 });
  return result?.trim() || 'Synthesis failed.';
}
