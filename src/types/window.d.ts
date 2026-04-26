/**
 * Ambient declarations for the per-page globals our content script uses.
 *
 * - `__voiceidoContentLoaded` — guards page_capture.ts against re-installing
 *   its message listener if injected multiple times by the service worker.
 */

interface Window {
  __voiceidoContentLoaded?: boolean;
}
