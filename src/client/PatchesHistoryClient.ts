import { signal } from '../event-signal.js';
import type { PatchesAPI } from '../net/protocol/types.js';
import type { Change, EditableVersionMetadata, ListVersionsOptions, VersionMetadata } from '../types.js';
import { applyChanges } from '../utils.js';

/**
 * LRU cache for version state+changes objects
 */
type VersionData = { state?: any; changes?: Change[] };
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  constructor(private readonly maxSize: number) {}
  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }
  set(key: K, value: V) {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, value);
    if (this.cache.size > this.maxSize) {
      // Remove least recently used
      const firstKeyIter = this.cache.keys().next();
      if (!firstKeyIter.done) {
        const firstKey = firstKeyIter.value;
        this.cache.delete(firstKey);
      }
    }
  }
  clear() {
    this.cache.clear();
  }
}

/**
 * Client-side history/scrubbing interface for a document.
 * Read-only: allows listing versions, loading states/changes, and scrubbing.
 */
export class PatchesHistoryClient<T = any> {
  /** Document ID */
  readonly id: string;
  /** Event signal for versions changes */
  readonly onVersionsChange = signal<(versions: VersionMetadata[]) => void>();
  /** Event signal for state changes */
  readonly onStateChange = signal<(state: T) => void>();

  private _versions: VersionMetadata[] = [];
  private _state: any = null;
  private cache = new LRUCache<string, VersionData>(6);

  constructor(
    id: string,
    private readonly api: PatchesAPI
  ) {
    this.id = id;
  }

  /** List of loaded versions */
  get versions() {
    return this._versions;
  }

  /** Current state (for scrubbing) */
  get state() {
    return this._state;
  }

  /** List version metadata for this document (with options) */
  async listVersions(options?: ListVersionsOptions): Promise<VersionMetadata[]> {
    this._versions = await this.api.listVersions(this.id, options);
    this.onVersionsChange.emit(this._versions);
    return this._versions;
  }

  /** Create a new named version snapshot of the document's current state. */
  async createVersion(metadata: EditableVersionMetadata): Promise<string> {
    const versionId = await this.api.createVersion(this.id, metadata);
    await this.listVersions(); // Refresh the list of versions
    return versionId;
  }

  /** Update the name of a specific version. */
  async updateVersion(versionId: string, metadata: EditableVersionMetadata): Promise<void> {
    await this.api.updateVersion(this.id, versionId, metadata);
    await this.listVersions(); // Refresh the list of versions
  }

  /** Load the state for a specific version */
  async getVersionState(versionId: string): Promise<any> {
    let data = this.cache.get(versionId);
    if (!data || data.state === undefined) {
      const { state } = await this.api.getVersionState(this.id, versionId);
      data = { ...data, state };
      this.cache.set(versionId, data);
    }
    this._state = data.state;
    this.onStateChange.emit(this._state);
    return data.state;
  }

  /** Load the changes for a specific version */
  async getVersionChanges(versionId: string): Promise<Change[]> {
    let data = this.cache.get(versionId);
    if (!data || data.changes === undefined) {
      const changes = await this.api.getVersionChanges(this.id, versionId);
      data = { ...data, changes };
      this.cache.set(versionId, data);
    }
    return data.changes!;
  }

  /** Scrub to a specific change within a version where changeIndex is 1-based and 0 is the parent version */
  async scrubTo(versionId: string, changeIndex: number): Promise<void> {
    const version = this.versions.find(v => v.id === versionId);

    // Load state and changes for the version
    const [state, changes] = await Promise.all([
      version?.parentId ? this.getVersionState(version.parentId) : undefined,
      this.getVersionChanges(versionId),
    ]);
    // Apply changes up to changeIndex to the state (if needed)
    if (changeIndex > 0) {
      this._state = applyChanges(state, changes.slice(0, changeIndex));
    }
    this.onStateChange.emit(this._state);
  }

  /** Clear caches and listeners */
  clear() {
    this._versions = [];
    this._state = null;
    this.onVersionsChange.emit(this._versions);
    this.onStateChange.emit(this._state);
    this.cache.clear();
    this.onVersionsChange.clear();
    this.onStateChange.clear();
  }
}
