import type { UiStatus } from '@veyra/shared';

/** Status labels and tones, the same on every screen. The server decides the status itself. */
export const STATUS_LABEL: Record<UiStatus, string> = {
  attention: 'Needs your attention',
  processing: 'Processing',
  ready: 'Ready',
  handled: 'Handled',
  rejected: 'Rejected',
};

export const STATUS_TONE: Record<UiStatus, 'attention' | 'handled' | 'received' | 'neutral'> = {
  attention: 'attention',
  handled: 'handled',
  ready: 'handled',
  processing: 'received',
  rejected: 'neutral',
};
