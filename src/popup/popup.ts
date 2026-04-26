/**
 * Popup script — opens on toolbar click. The popup is the "front door" of
 * the extension and reflects the background's progress messages in the UI.
 *
 * Behaviour summary:
 *   - On open, the popup shows the idle card with a primary
 *     "Run capture" button. Capture only starts when the user clicks it.
 *   - Mode + settings changes are persisted but do NOT start a capture.
 *   - In `innerSection` mode, clicking "Run capture" swaps to the picker
 *     hint card; capture proper begins on the first progress event.
 *   - User cancellation (Esc in the picker) lands on a soft "cancelled"
 *     state, never the hard error state, with a "Try again" button that
 *     returns to idle.
 */

import {
  DEFAULT_CAPTURE_OPTIONS,
  MESSAGE_TARGETS,
  isMessageFor,
  type CaptureCompleteEvent,
  type CaptureErrorEvent,
  type CaptureMode,
  type CaptureOptions,
  type CaptureProgressEvent,
  type CaptureSplitNotice,
  type StartCaptureRequest,
} from '../utils/messages';
import { loadCaptureOptions, saveCaptureOptions } from '../utils/preferences';

interface PopupRefs {
  idleState: HTMLElement;
  runButton: HTMLButtonElement;
  pickerState: HTMLElement;
  progressState: HTMLElement;
  progressBar: HTMLDivElement;
  progressBarHost: HTMLDivElement;
  progressCaption: HTMLParagraphElement;
  splitState: HTMLElement;
  splitCount: HTMLElement;
  completeState: HTMLElement;
  completeCount: HTMLElement;
  invalidState: HTMLElement;
  cancelledState: HTMLElement;
  noScrollState: HTMLElement;
  tooTallState: HTMLElement;
  errorState: HTMLElement;
  errorDetail: HTMLElement;
  retryButton: HTMLButtonElement;
  expandToggleSection: HTMLElement;
  expandToggle: HTMLInputElement;
  modeRadios: HTMLInputElement[];
  heroSubtitle: HTMLElement;
}

const refs = collectRefs();
let captureOptions: CaptureOptions = { ...DEFAULT_CAPTURE_OPTIONS };

void bootstrap();

// --------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  captureOptions = await loadCaptureOptions();
  syncOptionsToUi();
  bindModeRadios();
  bindToggle();
  bindRetry();
  bindRunButton();
  bindIncomingMessages();
  showIdle();
}

function collectRefs(): PopupRefs {
  const progressBar = requireEl<HTMLDivElement>('progress-bar');
  return {
    idleState: requireEl<HTMLElement>('state-idle'),
    runButton: requireEl<HTMLButtonElement>('run-capture'),
    pickerState: requireEl<HTMLElement>('state-picker'),
    progressState: requireEl<HTMLElement>('state-progress'),
    progressBar,
    progressBarHost: progressBar.parentElement as HTMLDivElement,
    progressCaption: requireEl<HTMLParagraphElement>('progress-caption'),
    splitState: requireEl<HTMLElement>('state-split'),
    splitCount: requireEl<HTMLElement>('split-count'),
    completeState: requireEl<HTMLElement>('state-complete'),
    completeCount: requireEl<HTMLElement>('complete-count'),
    invalidState: requireEl<HTMLElement>('state-invalid'),
    cancelledState: requireEl<HTMLElement>('state-cancelled'),
    noScrollState: requireEl<HTMLElement>('state-no-scroll'),
    tooTallState: requireEl<HTMLElement>('state-too-tall'),
    errorState: requireEl<HTMLElement>('state-error'),
    errorDetail: requireEl<HTMLElement>('error-detail'),
    retryButton: requireEl<HTMLButtonElement>('retry-button'),
    expandToggleSection: requireEl<HTMLElement>('settings'),
    expandToggle: requireEl<HTMLInputElement>('toggle-expand-scrollables'),
    modeRadios: [
      requireEl<HTMLInputElement>('mode-fullPage'),
      requireEl<HTMLInputElement>('mode-innerSection'),
    ],
    heroSubtitle: requireEl<HTMLElement>('hero-subtitle'),
  };
}

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}

function syncOptionsToUi(): void {
  for (const radio of refs.modeRadios) {
    radio.checked = radio.value === captureOptions.mode;
  }
  refs.expandToggle.checked = captureOptions.expandScrollables;
  toggleExpandVisibility(captureOptions.mode);
  updateHero(captureOptions.mode);
}

function updateHero(mode: CaptureMode): void {
  refs.heroSubtitle.textContent =
    mode === 'innerSection'
      ? 'Pick a scroll box once you press Run capture.'
      : 'Pick a mode, then run the capture.';
}

function bindModeRadios(): void {
  for (const radio of refs.modeRadios) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      const mode = radio.value as CaptureMode;
      captureOptions = { ...captureOptions, mode };
      void saveCaptureOptions(captureOptions);
      toggleExpandVisibility(mode);
      updateHero(mode);
      // Mode is persisted but we never auto-start a capture — the user
      // explicitly clicks "Run capture" so they're always in control.
    });
  }
}

function bindRunButton(): void {
  refs.runButton.addEventListener('click', () => {
    void startCapture();
  });
}

/** Reset the popup to the idle state with the prominent run button. */
function showIdle(): void {
  hideAllStates();
  show(refs.idleState);
  refs.errorDetail.textContent = '';
  refs.retryButton.classList.add('hidden');
}

function toggleExpandVisibility(mode: CaptureMode): void {
  if (mode === 'innerSection') hide(refs.expandToggleSection);
  else show(refs.expandToggleSection);
}

function bindToggle(): void {
  refs.expandToggle.addEventListener('change', () => {
    captureOptions = { ...captureOptions, expandScrollables: refs.expandToggle.checked };
    void saveCaptureOptions(captureOptions);
  });
}

function bindRetry(): void {
  refs.retryButton.addEventListener('click', () => {
    void startCapture();
  });
}

function bindIncomingMessages(): void {
  chrome.runtime.onMessage.addListener((message) => {
    if (
      isMessageFor<CaptureProgressEvent>(message, MESSAGE_TARGETS.popup, 'CAPTURE_PROGRESS')
    ) {
      // First progress tick means picker has resolved (if we were in
      // innerSection mode) and real capture work has begun. Swap in the
      // progress bar.
      hide(refs.pickerState);
      show(refs.progressState);
      const pct = Math.round(message.complete * 100);
      setProgress(pct, captionForProgress(pct, message.imageCount));
      return false;
    }

    if (isMessageFor<CaptureSplitNotice>(message, MESSAGE_TARGETS.popup, 'CAPTURE_SPLIT')) {
      refs.splitCount.textContent = String(message.imageCount);
      show(refs.splitState);
      return false;
    }

    if (
      isMessageFor<CaptureCompleteEvent>(message, MESSAGE_TARGETS.popup, 'CAPTURE_COMPLETE')
    ) {
      hide(refs.pickerState);
      show(refs.progressState);
      setProgress(100, 'Capture complete — opening result tab(s)…');
      refs.completeCount.textContent = String(message.imageCount);
      show(refs.completeState);
      return false;
    }

    if (isMessageFor<CaptureErrorEvent>(message, MESSAGE_TARGETS.popup, 'CAPTURE_ERROR')) {
      handleError(message);
      return false;
    }

    return false;
  });
}

async function startCapture(): Promise<void> {
  hideAllStates();
  refs.errorDetail.textContent = '';
  refs.retryButton.classList.add('hidden');
  refs.retryButton.textContent = 'Try again';

  // In picker mode, surface the picker hint card immediately. The progress
  // bar will replace it on the first CAPTURE_PROGRESS tick.
  if (captureOptions.mode === 'innerSection') {
    show(refs.pickerState);
  } else {
    show(refs.progressState);
    setProgress(0, 'Starting capture…');
  }

  try {
    const request: StartCaptureRequest = {
      type: 'START_CAPTURE',
      target: MESSAGE_TARGETS.background,
      options: captureOptions,
    };
    const response = (await chrome.runtime.sendMessage(request)) as
      | { ok: boolean; detail?: string }
      | undefined;
    if (!response?.ok) {
      if (response?.detail) refs.errorDetail.textContent = response.detail;
    }
  } catch (error) {
    handleError({
      type: 'CAPTURE_ERROR',
      target: MESSAGE_TARGETS.popup,
      code: 'UNKNOWN',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleError(event: CaptureErrorEvent): void {
  hideAllStates();
  refs.errorDetail.textContent = '';

  switch (event.code) {
    case 'INVALID_URL':
      show(refs.invalidState);
      refs.retryButton.classList.add('hidden');
      return;
    case 'PICKER_CANCELLED':
      show(refs.cancelledState);
      refs.retryButton.textContent =
        captureOptions.mode === 'innerSection' ? 'Choose section again' : 'Try again';
      refs.retryButton.classList.remove('hidden');
      return;
    case 'NO_SCROLL_ANCESTOR':
      show(refs.noScrollState);
      refs.retryButton.textContent = 'Pick a different element';
      refs.retryButton.classList.remove('hidden');
      return;
    case 'ELEMENT_TOO_TALL':
      show(refs.tooTallState);
      refs.retryButton.textContent = 'Try again';
      refs.retryButton.classList.remove('hidden');
      return;
    default:
      show(refs.errorState);
      refs.errorDetail.textContent = event.detail ?? '';
      refs.retryButton.textContent = 'Try again';
      refs.retryButton.classList.remove('hidden');
  }
}

function hideAllStates(): void {
  hide(refs.idleState);
  hide(refs.pickerState);
  hide(refs.progressState);
  hide(refs.splitState);
  hide(refs.completeState);
  hide(refs.invalidState);
  hide(refs.cancelledState);
  hide(refs.noScrollState);
  hide(refs.tooTallState);
  hide(refs.errorState);
}

function setProgress(percent: number, caption: string): void {
  const clamped = Math.max(0, Math.min(100, percent));
  refs.progressBar.style.right = `${100 - clamped}%`;
  refs.progressBarHost.setAttribute('aria-valuenow', String(clamped));
  refs.progressCaption.textContent = caption;
}

function captionForProgress(percent: number, imageCount: number): string {
  if (percent >= 100) return 'Stitching final image…';
  if (imageCount > 1) return `Capturing… ${percent}% (${imageCount} tiles)`;
  return `Capturing… ${percent}%`;
}

function show(el: HTMLElement): void {
  el.classList.remove('hidden');
}

function hide(el: HTMLElement): void {
  el.classList.add('hidden');
}
