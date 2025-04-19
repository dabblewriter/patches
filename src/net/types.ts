export type SyncingState = 'initial' | 'updating' | null | Error;

export interface PatchesState {
  online: boolean; // window.navigator.onLine
  connected: boolean; // ws transport state === 'connected'
  syncing: SyncingState; // null when idle
}
