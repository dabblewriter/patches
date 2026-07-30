import { describe, expect, it } from 'vitest';
import { JSONPatch } from '../../src/json-patch/JSONPatch';
import type { JSONPatchOp } from '../../src/types';

/**
 * Aliasing regressions for JSONPatch.transform()/compose(): transformPatch (and
 * composePatch via mapAndFilterOps) return their input ops array BY IDENTITY when no op
 * needed changing — the disjoint-paths common case. The wrapping JSONPatch must copy, or
 * its builder methods (`this.ops.push`) append into the SOURCE patch/array. Same aliasing
 * class as the OTDoc optimistic-ops fix (#127), on the public API surface.
 */
describe('JSONPatch.transform aliasing', () => {
  it('does not entangle the transformed patch with the source patch on a no-op transform', () => {
    const server = new JSONPatch().replace('/title', 'New Title');
    const local = new JSONPatch().replace('/body', 'Hello'); // disjoint path — transform is a no-op

    const rebased = server.transform(local);
    expect(rebased.ops).not.toBe(local.ops);

    rebased.add('/authorNote', 'draft');

    expect(local.ops).toEqual([{ op: 'replace', path: '/body', value: 'Hello' }]);
    expect(rebased.ops).toHaveLength(2);
  });

  it('does not entangle when this patch has no ops (reduce seed pass-through)', () => {
    const other = new JSONPatch().replace('/a', 1);

    const transformed = new JSONPatch().transform(other);
    transformed.remove('/b');

    expect(other.ops).toEqual([{ op: 'replace', path: '/a', value: 1 }]);
  });

  it('does not mutate a caller-owned raw ops array (array overload)', () => {
    const rawOps: JSONPatchOp[] = [{ op: 'replace', path: '/body', value: 'Hello' }];
    const server = new JSONPatch().replace('/title', 'x');

    const rebased = server.transform(rawOps);
    rebased.add('/c', true);

    expect(rawOps).toEqual([{ op: 'replace', path: '/body', value: 'Hello' }]);
  });

  it('still transforms for real when paths do collide', () => {
    const server = new JSONPatch().remove('/list/0');
    const local = new JSONPatch().replace('/list/1', 'second');

    const rebased = server.transform(local);

    // The colliding op was actually transformed (index shifted down) — the copy must not
    // suppress real transformation.
    expect(rebased.ops).toEqual([{ op: 'replace', path: '/list/0', value: 'second' }]);
    expect(local.ops).toEqual([{ op: 'replace', path: '/list/1', value: 'second' }]);
  });
});

describe('JSONPatch.compose aliasing', () => {
  it('does not entangle the composed patch with the source in the no-arg form', () => {
    const source = new JSONPatch().add('/x', 1).remove('/y'); // nothing composable

    const composed = source.compose();
    composed.replace('/z', 2);

    expect(source.ops).toEqual([
      { op: 'add', path: '/x', value: 1 },
      { op: 'remove', path: '/y' },
    ]);
    expect(composed.ops).toHaveLength(3);
  });
});
