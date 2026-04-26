import vision from '@google-cloud/vision';

let client: vision.ImageAnnotatorClient | null = null;

/**
 * Lazy singleton — creates the Vision client on first use so a cold start
 * doesn't pay the auth tax until we know there's work to do. On Cloud Run
 * the client picks up Application Default Credentials from the runtime
 * service account.
 */
function getClient(): vision.ImageAnnotatorClient {
  if (!client) client = new vision.ImageAnnotatorClient();
  return client;
}

/**
 * Run OCR on raw image bytes.
 *
 * @param buffer        Binary contents (PNG / JPEG / etc.)
 * @param preserveLayout `true` ⇒ documentTextDetection (preserves paragraph
 *   structure, ideal for screenshots of structured docs); `false` ⇒
 *   textDetection (cheaper, simpler).
 */
export async function ocrImage(buffer: Buffer, preserveLayout = false): Promise<string> {
  const c = getClient();
  const [result] = preserveLayout
    ? await c.documentTextDetection({ image: { content: buffer } })
    : await c.textDetection({ image: { content: buffer } });

  const apiError = (result as { error?: { message?: string } }).error;
  if (apiError?.message) throw new Error(`Vision API: ${apiError.message}`);

  if (preserveLayout && result.fullTextAnnotation?.text) {
    return result.fullTextAnnotation.text;
  }
  const det = result.textAnnotations?.[0];
  return det?.description ?? '';
}
