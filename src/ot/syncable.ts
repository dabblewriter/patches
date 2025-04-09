import { inc } from 'alphacounter';
import { applyPatch } from '../json-patch/applyPatch.js';
import { JSONPatch } from '../json-patch/jsonPatch.js';
import { applyBitmask, combineBitmasks } from '../json-patch/ops/bitmask.js';
import { JSONPatchOp } from '../types.js';
import { isArrayPath, toKeys } from '../utils/index.js';

export type Subscriber<T> = (value: T, meta: SyncableMetadata, hasUnsentChanges: boolean) => void;
export type PatchSubscriber = (value: JSONPatchOp[], rev: string) => void;
export type Unsubscriber = () => void;
export type Sender<T = Record<string, any>> = (changes: JSONPatchOp[]) => Promise<T>;
export type DocRev<T = Record<string, any>> = [T, string];
export type PatchRev = [JSONPatchOp[], string];
export type PatchRevPatch = [JSONPatchOp[], string, JSONPatchOp[]];

export interface SyncableClient<T = Record<string, any>> {
  subscribe: (run: Subscriber<T>) => Unsubscriber;
  change: (patch: JSONPatch | JSONPatchOp[]) => T;
  receive: (patch: JSONPatch | JSONPatchOp[], rev: string, overwriteChanges?: boolean) => T;
  send<T>(sender: Sender<T>): Promise<T | void>;
  get(): T;
  getAll(): [T, SyncableMetadata];
  getMeta(): SyncableMetadata;
  getRev(): string;
  set(value: T, meta: SyncableMetadata): void;
}

export interface SyncableServer<T = Record<string, any>> {
  onPatch: (run: PatchSubscriber) => Unsubscriber;
  getPendingPatch: () => Promise<{ patch: JSONPatchOp[]; rev: string }>;
  subscribe: (run: Subscriber<T>) => Unsubscriber;
  change: (patch: JSONPatch | JSONPatchOp[]) => PatchRev;
  receive: (patch: JSONPatch | JSONPatchOp[], rev?: string, ignoreBlackLists?: boolean) => PatchRevPatch;
  changesSince: (rev?: string) => PatchRev;
  get(): T;
  getAll(): [T, SyncableMetadata];
  getMeta(): SyncableMetadata;
  getRev(): string;
  set(value: T, meta: SyncableMetadata): void;
}

export type Combiner = {
  combine: (a: number, b: number) => number;
  apply: (a: number, b: number) => number;
};

export type CombinableOps = {
  [name: string]: Combiner;
};

const combinableOps: CombinableOps = {
  '@inc': {
    combine: (a, b) => a + b,
    apply: (a, b) => a + b,
  },
  '@bit': {
    combine: combineBitmasks,
    apply: applyBitmask,
  },
};

/**
 * A map of paths that have been changed. The value is zero except for @inc operations which have a number to track the
 * increment value and @bit to track the bitmask operation. 2 @inc operations may be combined and 2 @bit operations may
 * be combined.
 */
export type Changes = Record<string, ChangeOp>;
export type ChangeOp = { [op: string]: number } | null;

export interface SyncableMetadata {
  rev: string;
  changed?: Changes;
  paths?: {
    [key: string]: string;
  };
}

export type SyncableOptions = {
  whitelist?: Set<string>;
  blacklist?: Set<string>;
  revPad?: number;
};

export interface SyncableServerOptions extends SyncableOptions {
  server: true;
}

export function syncable<T>(object: T, meta?: SyncableMetadata, options?: SyncableOptions): SyncableClient<T>;
export function syncable<T>(
  object: T,
  meta: SyncableMetadata | undefined,
  options: SyncableServerOptions
): SyncableServer<T>;
export function syncable<T>(
  object: T,
  meta: SyncableMetadata = { rev: '' },
  options: SyncableOptions = {}
): SyncableClient<T> & SyncableServer<T> {
  let rev = meta.rev || (options.revPad ? '0'.repeat(options.revPad) : '');
  let paths = meta.paths || {};
  let changed = { ...meta.changed };
  if (typeof Object.values(changed)[0] === 'number') {
    // Convert old format to new format
    for (const [key, value] of Object.entries(changed)) {
      if (typeof value === 'number') changed[key] = value === 0 ? null : { '@inc': value };
    }
  }
  let sending: Set<string> | null = null;
  let receiving = new Map<string, JSONPatchOp[]>();
  let pendingPatchPromise = Promise.resolve({ patch: [] as JSONPatchOp[], rev: '' });
  meta = getMeta();

  const subscribers: Set<Subscriber<T>> = new Set();
  const patchSubscribers: Set<PatchSubscriber> = new Set();
  const { whitelist, blacklist, server } = options as SyncableServerOptions;

  function change(patch: JSONPatch | JSONPatchOp[]) {
    if ('ops' in patch) patch = patch.ops;
    // If server is true, this is an admin operation on the server which will bypass the blacklists/whitelists
    if (!server) {
      patch.forEach(patch => {
        if (whitelist?.size && !pathExistsIn(patch.path, whitelist)) {
          throw new TypeError(`${patch.path} is not a whitelisted property for this Syncable Object`);
        }
        if (blacklist?.size && pathExistsIn(patch.path, blacklist)) {
          throw new TypeError(`${patch.path} is a blacklisted property for this Syncable Object`);
        }
        const [target] = getTargetAndKey(patch.path);
        if (isArrayPath(patch.path) && Array.isArray(target)) {
          throw new TypeError('Last-write-wins cannot be used with array entries');
        }
      });
    }
    const result = applyPatch(object, patch, { strict: true, createMissingObjects: true });
    if (result === object) return server ? [[], rev] : result; // no changes made
    object = result;
    if (server) setRev(patch, (rev = inc(rev, options.revPad)));
    else patch.forEach(op => addChange(op));
    return dispatchChanges(patch);
  }

  // This method is necessary to track in-flight sent properties to avoid property flickering as described here:
  // https://www.figma.com/blog/how-figmas-multiplayer-technology-works/#syncing-object-properties.
  async function send<T>(sender: Sender<T>): Promise<T | void> {
    if (!Object.keys(changed).length || sending) return;
    sending = new Set(Object.keys(changed));
    const oldChanged = changed;
    changed = {};
    const changes = Array.from(sending).map(path => getPatchOp(path, oldChanged[path]));
    let result: any;
    try {
      result = await sender(changes);
      sending = null;
      receiving.clear();
    } finally {
      if (sending) {
        // Reset state on error to allow for another send
        changed = Object.keys({ ...oldChanged, ...changed }).reduce((obj, key) => {
          obj[key] = combineChanges(oldChanged[key], changed[key]);
          return obj;
        }, {} as Changes);
        sending = null;
        if (receiving.size) {
          receiving.forEach((patch, rev) => receive(patch, rev));
          receiving.clear();
        }
      }
    }
    return result;
  }

  function receive(patch: JSONPatch | JSONPatchOp[], rev?: string, ignoreLists?: boolean): PatchRevPatch;
  function receive(patch: JSONPatch | JSONPatchOp[], rev: string, overwriteChanges?: boolean): T;
  function receive(patch: JSONPatch | JSONPatchOp[], rev_?: string, overwriteChanges?: boolean) {
    const ignoreLists = overwriteChanges;
    if ('ops' in patch) patch = patch.ops;
    const clientUpdates: JSONPatchOp[] = server && rev_ && inc.is(rev_).lt(rev) ? changesSince(rev_)[0] : [];

    patch = patch.filter(patch => {
      // Filter out any patches that are in-flight being sent to the server as they will overwrite this change (to avoid flicker)
      if (sending && isSending(patch.path)) {
        // Store the ignored patches so if the in-flight call fails these changes can still be received and applied
        let recOps = receiving.get(rev_ || '');
        if (!recOps) receiving.set(rev_ || '', (recOps = []));
        recOps.push(patch);
        return false;
      }
      const changedOp = changed[patch.path];
      let changedOpName: string;
      let changedOpValue: number;
      if (changedOp) {
        [changedOpName, changedOpValue] = Object.entries(changedOp)[0];
      }
      // Remove from changed if it's about to be overwritten (usually you should be sending changes immediately)
      if (overwriteChanges && patch.path in changed) delete changed[patch.path];
      else if (
        typeof patch.value === 'number' &&
        !combinableOps[patch.op] &&
        changedOp &&
        combinableOps[changedOpName!]
      ) {
        patch.value = combinableOps[changedOpName!].apply(patch.value, changedOpValue!);
      }
      return true;
    });

    // If this is a server commit from a client
    if (server) {
      // if there are any possible changes to the patch
      if (clientUpdates.length || (!ignoreLists && (whitelist || blacklist))) {
        const paths = new Set(clientUpdates.map(op => op.path));
        patch = patch.filter(patch => {
          // If the client sends a rev, it doesn't want to conflict with changes that came after its known state, so
          // we will remove any patches that are superceded by another client's change.
          if (paths.size && pathExistsIn(patch.path, paths)) {
            return false;
          }
          // Remove anything that is excluded by the whitelist or blacklist
          if (
            (whitelist?.size && !pathExistsIn(patch.path, whitelist)) ||
            (blacklist?.size && pathExistsIn(patch.path, blacklist))
          ) {
            // Revert data back that shouldn't change
            clientUpdates.push(getPatchOp(patch.path));
            return false;
          }
          return patch;
        });
      }
    } else if (!rev_) {
      // Should always get a rev from the server
      throw new Error('Received a patch without a rev');
    } else if (typeof rev_ === 'string' && inc.is(rev).gt(rev_)) {
      // Already have the latest revision
      return object;
    } else {
      rev = rev_;
    }

    const updateObj = applyPatch(object, patch, { strict: true, createMissingObjects: true });
    if (updateObj === object) return server ? [clientUpdates, rev, []] : updateObj; // no changes made
    if (server) {
      // We only want to update server rev if changes were actually made
      rev = inc(rev, options.revPad);
      setRev(patch, rev);
    }
    object = updateObj;
    patch.forEach(patch => patch.op.startsWith('@') && clientUpdates.push(getPatchOp(patch.path)));
    const result = dispatchChanges(patch);
    return server ? [clientUpdates, result[1], result[0]] : result;
  }

  function changesSince(rev_?: string): PatchRev {
    const patch: JSONPatchOp[] = [];
    if (!rev_) {
      patch.push({ op: 'replace', path: '', value: object });
    } else {
      for (const [path, r] of Object.entries(paths)) {
        if (inc.is(r).gt(rev_)) patch.push(getPatchOp(path));
      }
    }
    return [patch, rev];
  }

  function subscribe(run: Subscriber<T>): Unsubscriber {
    subscribers.add(run);
    run(object, meta, Object.keys(changed).length > 0);
    return () => subscribers.delete(run);
  }

  function onPatch(run: PatchSubscriber): Unsubscriber {
    patchSubscribers.add(run);
    return () => patchSubscribers.delete(run);
  }

  // this just helps with testing and is not needed for use
  function getPendingPatch() {
    return pendingPatchPromise;
  }

  function get(): T {
    return object;
  }

  function getAll(): [T, SyncableMetadata] {
    return [object, getMeta()];
  }

  function getMeta(): SyncableMetadata {
    const meta: SyncableMetadata = { rev };
    if (Object.keys(changed).length) meta.changed = { ...changed };
    if (Object.keys(paths).length) meta.paths = paths;
    return meta;
  }

  function getRev(): string {
    return rev;
  }

  function set(value: T, meta: SyncableMetadata): void {
    object = value;
    rev = meta.rev;
    paths = meta.paths || {};
    changed = meta.changed || {};
    sending = null;
  }

  function setRev(patch: JSONPatch | JSONPatchOp[], rev: string) {
    if ('ops' in patch) patch = patch.ops;
    patch
      .map(op => op.path)
      .sort((a, b) => b.length - a.length)
      .forEach(path => {
        const prefix = `${path}/`;
        for (const key of Object.keys(paths)) {
          if (path && key.startsWith(prefix)) {
            delete paths[key];
          }
        }
        paths[path] = rev;
      });
    return rev;
  }

  function dispatchChanges(patch: JSONPatch | JSONPatchOp[]): PatchRev;
  function dispatchChanges(patch: JSONPatch | JSONPatchOp[]): T;
  function dispatchChanges(patch: JSONPatch | JSONPatchOp[]) {
    if ('ops' in patch) patch = patch.ops;
    const thisRev = rev;
    meta = getMeta();
    const hasUnsentChanges = Object.keys(changed).length > 0;
    subscribers.forEach(subscriber => subscriber(object, meta, !server && hasUnsentChanges));
    if (server) {
      patch = patch.map(patch => (patch.op.startsWith('@') ? getPatchOp(patch.path) : patch));
      pendingPatchPromise = Promise.resolve().then(() => {
        patchSubscribers.forEach(onPatch => onPatch(patch as JSONPatchOp[], thisRev));
        return { patch: patch as JSONPatchOp[], rev: thisRev };
      });
      return [patch, thisRev];
    }
    return object;
  }

  function addChange(op: JSONPatchOp) {
    // Filter out redundant paths such as removing /foo/bar/baz when /foo exists
    if (changed[''] && !combinableOps[op.op]) return;
    if (op.op === 'test') return;
    if (op.path === '') {
      changed = { '': null };
    } else {
      // Shortcut, if the exact path exists in changed then there should be no sub-paths needing to be removed
      if (!(op.path in changed)) {
        const prefix = `${op.path}/`;
        const keys = Object.keys(changed);
        for (let i = 0; i < keys.length; i++) {
          const path = keys[i];
          // The path is being overwritten with this change, so we can remove it
          if (path.startsWith(prefix)) {
            delete changed[path];
          } else if (op.path.startsWith(`${path}/`)) {
            // The path is a parent of this change. Since the parent will be sent, the child doesn't need to be
            return;
          }
        }
      }
      if (combinableOps[op.op]) {
        let value = op.value;
        const changedOp = changed[op.path];
        if (changedOp && typeof op.value === 'number') {
          const [oldOp, oldValue] = Object.entries(changedOp)[0];
          if (oldOp === op.op) value = combinableOps[oldOp].combine(oldValue, op.value);
        }
        // a 0 increment is nothing, so delete it, we're using 0 to indicate other fields that have been changed
        if (changedOp && !value) delete changed[op.path];
        else changed[op.path] = { [op.op]: value };
      } else {
        if (op.op === 'move') changed[op.from as string] = null;
        changed[op.path] = null;
      }
    }
  }

  function combineChanges(changeA: ChangeOp = null, changeB: ChangeOp = null): ChangeOp {
    if (changeA && changeB) {
      const [opA, valueA] = Object.entries(changeA)[0];
      const [opB, valueB] = Object.entries(changeB)[0];
      if (opA === opB && combinableOps[opA]) {
        return { [opA]: combinableOps[opA].combine(valueA, valueB) };
      }
    }
    return changeB;
  }

  function isSending(path: string): boolean {
    return !!(sending && pathExistsIn(path, sending));
  }

  const cachedPathExpr = new WeakMap<any, RegExp>();

  function pathExistsIn(path: string, prefixes: Changes | Set<string>): boolean {
    // Support wildcard such as '/docs/*/title'
    let expr = cachedPathExpr.get(prefixes);
    if (!expr) {
      expr = getPathExpr(prefixes);
      cachedPathExpr.set(prefixes, expr);
    }
    return expr.test(path);
  }

  function getPatchOp(path: string, changeOp?: ChangeOp): JSONPatchOp {
    if (path === '') return { op: 'replace', path, value: object };
    const [target, key] = getTargetAndKey(path);
    if (changeOp) {
      const [op, value] = Object.entries(changeOp)[0];
      return { op, path, value };
    } else if (target && key in target) {
      return { op: 'replace', path, value: target[key] };
    } else {
      return { op: 'remove', path };
    }
  }

  function getTargetAndKey(path: string): [any, string] {
    const keys = toKeys(path);
    let target = object as any;
    for (let i = 1, imax = keys.length - 1; i < imax; i++) {
      const key = keys[i];
      if (!target[key]) {
        target = null;
        break;
      }
      target = target[key];
    }
    return [target, keys[keys.length - 1]];
  }

  const exprCache: { [path: string]: RegExp } = {};
  function getPathExpr(paths: Changes | Set<string>) {
    const isSet = paths instanceof Set;
    const pathsStrings = isSet ? Array.from(paths) : Object.keys(paths);
    let expr = exprCache[pathsStrings.toString()];
    if (expr) return expr;
    expr = new RegExp(pathsStrings.map(prop => `^${prop.replace(/\*/g, '[^\\/]*')}(/.*)?$`).join('|'));
    if (isSet) exprCache[pathsStrings.toString()] = expr;
    return expr;
  }

  return {
    subscribe,
    onPatch,
    getPendingPatch,
    change,
    send,
    receive,
    changesSince,
    get,
    getAll,
    getMeta,
    getRev,
    set,
  };
}
