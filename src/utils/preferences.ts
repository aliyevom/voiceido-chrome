/**
 * Persisted user preferences. Stored in chrome.storage.local so they survive
 * service-worker restarts and sync across popup / background / preview-page
 * contexts.
 */

import { DEFAULT_CAPTURE_OPTIONS, type CaptureOptions } from './messages';

const CAPTURE_OPTIONS_KEY = 'voiceido.capture.options';
const API_SETTINGS_KEY = 'voiceido.api.settings';

interface CaptureStorageShape {
  [CAPTURE_OPTIONS_KEY]?: CaptureOptions;
}

/**
 * Connection settings for the cloud-hosted OCR + Analyze microservice.
 *
 * `baseUrl` should point at the Cloud Run URL produced by `cloud/deploy.sh`
 * (e.g. `https://voiceido-api-xyz-uc.a.run.app`). `apiKey` is the shared
 * secret expected in the `X-API-Key` header by the backend.
 *
 * Both default to empty so the preview page can prompt the user to configure
 * them before the OCR / Analyze buttons become live.
 */
export interface ApiSettings {
  baseUrl: string;
  apiKey: string;
}

export const DEFAULT_API_SETTINGS: ApiSettings = {
  baseUrl: '',
  apiKey: '',
};

interface ApiStorageShape {
  [API_SETTINGS_KEY]?: ApiSettings;
}

export async function loadCaptureOptions(): Promise<CaptureOptions> {
  try {
    const stored = (await chrome.storage.local.get(CAPTURE_OPTIONS_KEY)) as CaptureStorageShape;
    const value = stored[CAPTURE_OPTIONS_KEY];
    if (!value) return { ...DEFAULT_CAPTURE_OPTIONS };
    return { ...DEFAULT_CAPTURE_OPTIONS, ...value };
  } catch {
    return { ...DEFAULT_CAPTURE_OPTIONS };
  }
}

export async function saveCaptureOptions(options: CaptureOptions): Promise<void> {
  await chrome.storage.local.set({ [CAPTURE_OPTIONS_KEY]: options });
}

export async function loadApiSettings(): Promise<ApiSettings> {
  try {
    const stored = (await chrome.storage.local.get(API_SETTINGS_KEY)) as ApiStorageShape;
    const value = stored[API_SETTINGS_KEY];
    if (!value) return { ...DEFAULT_API_SETTINGS };
    return { ...DEFAULT_API_SETTINGS, ...value };
  } catch {
    return { ...DEFAULT_API_SETTINGS };
  }
}

export async function saveApiSettings(settings: ApiSettings): Promise<void> {
  const trimmed: ApiSettings = {
    baseUrl: settings.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: settings.apiKey.trim(),
  };
  await chrome.storage.local.set({ [API_SETTINGS_KEY]: trimmed });
}

export function isApiConfigured(settings: ApiSettings): boolean {
  return Boolean(settings.baseUrl) && Boolean(settings.apiKey);
}
