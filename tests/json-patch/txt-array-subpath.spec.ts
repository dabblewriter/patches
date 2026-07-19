import { Delta } from '@dabble/delta';
import { describe, expect, it } from 'vitest';
import { applyPatch } from '../../src/json-patch/applyPatch.js';
import { transformPatch } from '../../src/json-patch/transformPatch.js';

/**
 * `@txt` ops addressed INSIDE an array element (`/list/<index>/text`) must survive
 * concurrent structural edits to the same array: positional shifting against
 * add/remove, following a moved element, and dropping cleanly when the element is
 * removed or overwritten. Clients that keep rich text on array elements (rather
 * than object fields) depend on every one of these — a wrong index after transform
 * writes text into a SIBLING element.
 */
describe('@txt at array-element sub-paths', () => {
  const el = (id: string, text: string) => ({ id, text: { ops: [{ insert: `${text}\n` }] } });
  const state = { list: [el('a', 'aaa'), el('b', 'bbb'), el('c', 'ccc'), el('d', 'ddd')] };

  const txt = (path: string) => ({ op: '@txt', path, value: [{ insert: 'x' }] });

  describe('against concurrent add', () => {
    it('shifts up when an element is inserted at a lower index', () => {
      expect(
        transformPatch(state, [{ op: 'add', path: '/list/0', value: el('n', 'new') }], [txt('/list/1/text')])
      ).toEqual([txt('/list/2/text')]);
    });

    it('shifts up when an element is inserted at the same index', () => {
      expect(
        transformPatch(state, [{ op: 'add', path: '/list/1', value: el('n', 'new') }], [txt('/list/1/text')])
      ).toEqual([txt('/list/2/text')]);
    });

    it('stays put when an element is inserted at a higher index', () => {
      expect(
        transformPatch(state, [{ op: 'add', path: '/list/2', value: el('n', 'new') }], [txt('/list/1/text')])
      ).toEqual([txt('/list/1/text')]);
    });

    it('stays put when an element is appended', () => {
      expect(
        transformPatch(state, [{ op: 'add', path: '/list/4', value: el('n', 'new') }], [txt('/list/1/text')])
      ).toEqual([txt('/list/1/text')]);
    });
  });

  describe('against concurrent remove', () => {
    it('shifts down when an element is removed at a lower index', () => {
      expect(transformPatch(state, [{ op: 'remove', path: '/list/0' }], [txt('/list/1/text')])).toEqual([
        txt('/list/0/text'),
      ]);
    });

    it('drops when its own element is removed', () => {
      expect(transformPatch(state, [{ op: 'remove', path: '/list/1' }], [txt('/list/1/text')])).toEqual([]);
    });

    it('stays put when an element is removed at a higher index', () => {
      expect(transformPatch(state, [{ op: 'remove', path: '/list/2' }], [txt('/list/1/text')])).toEqual([
        txt('/list/1/text'),
      ]);
    });
  });

  describe('against concurrent move', () => {
    it('follows its own element when it moves to a higher index', () => {
      expect(transformPatch(state, [{ op: 'move', from: '/list/1', path: '/list/3' }], [txt('/list/1/text')])).toEqual([
        txt('/list/3/text'),
      ]);
    });

    it('follows its own element when it moves to a lower index', () => {
      expect(transformPatch(state, [{ op: 'move', from: '/list/2', path: '/list/0' }], [txt('/list/2/text')])).toEqual([
        txt('/list/0/text'),
      ]);
    });

    it('shifts down when another element moves from below to above it', () => {
      expect(transformPatch(state, [{ op: 'move', from: '/list/0', path: '/list/2' }], [txt('/list/1/text')])).toEqual([
        txt('/list/0/text'),
      ]);
    });

    it('shifts up when another element moves from above to below it', () => {
      expect(transformPatch(state, [{ op: 'move', from: '/list/2', path: '/list/0' }], [txt('/list/1/text')])).toEqual([
        txt('/list/2/text'),
      ]);
    });

    it('stays put when another element moves entirely above it', () => {
      expect(transformPatch(state, [{ op: 'move', from: '/list/2', path: '/list/3' }], [txt('/list/1/text')])).toEqual([
        txt('/list/1/text'),
      ]);
    });
  });

  describe('against concurrent writes to the same element', () => {
    it('transforms against a concurrent @txt at the same sub-path as text, not LWW', () => {
      expect(
        transformPatch(
          state,
          [{ op: '@txt', path: '/list/1/text', value: [{ insert: 'first' }] }],
          [{ op: '@txt', path: '/list/1/text', value: [{ insert: 'second' }] }]
        )
      ).toEqual([{ op: '@txt', path: '/list/1/text', value: [{ retain: 5 }, { insert: 'second' }] }]);
    });

    it('threads through a batch of sequential @txt ops on the same sub-path', () => {
      // Ops within one patch each apply after the previous, so ours has to be advanced over
      // every one of them to stay in the same coordinate space — see the delta threading in
      // `text.transform`. A queue that batches content edits emits exactly this shape, and a
      // single-op test can't tell correct threading apart from transforming only against the
      // first op.
      const theirs = [
        { op: '@txt', path: '/list/1/text', value: [{ retain: 1 }, { insert: 'AAA' }] },
        { op: '@txt', path: '/list/1/text', value: [{ retain: 2 }, { insert: 'B' }] },
      ];
      const ours = [{ op: '@txt', path: '/list/1/text', value: [{ retain: 2 }, { insert: 'S' }] }];

      const transformed = transformPatch(state, theirs, ours);
      expect(transformed).toEqual([{ op: '@txt', path: '/list/1/text', value: [{ retain: 6 }, { insert: 'S' }] }]);

      // 'bbb\n' + their two edits = 'bABAAbb\n', where the base chars now sit at 0, 5 and 6.
      // Ours still lands between the two it was written between, not at its original (now
      // stale) offset of 2.
      const converged = applyPatch(applyPatch(state, theirs), transformed) as typeof state;
      expect(converged.list[1].text).toEqual({ ops: [{ insert: 'bABAAbSb\n' }] });
    });

    it('survives a wholesale replace of the same sub-path and composes onto the new content', () => {
      // Same semantics as `@txt` vs `replace` at an object path (see transform.spec.ts):
      // the text op is not clobbered — it applies after the replace. This is what keeps a
      // mixed fleet safe: an old client replacing the whole text object concurrent with a
      // new client's incremental edit loses neither write.
      const replace = [{ op: 'replace', path: '/list/1/text', value: { ops: [{ insert: 'rewritten\n' }] } }];
      const transformed = transformPatch(state, replace, [txt('/list/1/text')]);
      expect(transformed).toEqual([txt('/list/1/text')]);

      // Surviving is only half of it — the op has to land on the replaced content, not the
      // content it was written against. Neither write is lost.
      const converged = applyPatch(applyPatch(state, replace), transformed) as typeof state;
      expect(converged.list[1].text).toEqual({ ops: [{ insert: 'xrewritten\n' }] });
    });

    it('drops when its whole element was replaced', () => {
      expect(
        transformPatch(state, [{ op: 'replace', path: '/list/1', value: el('b', 'rewritten') }], [txt('/list/1/text')])
      ).toEqual([]);
    });
  });

  describe('apply', () => {
    it('composes onto existing `{ ops }` content at an array-element sub-path', () => {
      const result = applyPatch(state, [
        { op: '@txt', path: '/list/1/text', value: [{ insert: 'x' }] },
      ]) as typeof state;
      expect(result.list[1].text).toEqual({ ops: [{ insert: 'xbbb\n' }] });
      expect(result.list[0]).toBe(state.list[0]); // untouched siblings keep identity
    });

    it('seeds an empty document when the element has no content yet', () => {
      const bare = { list: [{ id: 'a' }] };
      const result = applyPatch(bare, [{ op: '@txt', path: '/list/0/text', value: [{ insert: 'x' }] }]) as {
        list: { id: string; text?: unknown }[];
      };
      expect(result.list[0].text).toEqual({ ops: [{ insert: 'x\n' }] });

      // What gets stored is a Delta instance, not a plain `{ ops }` literal — `toEqual` treats
      // the two as equal, so pin it explicitly. Consumers that structurally clone the document
      // (persisting to IndexedDB, posting across a worker) get the plain shape back out.
      expect(result.list[0].text).toBeInstanceOf(Delta);
      expect(structuredClone(result.list[0].text)).toEqual({ ops: [{ insert: 'x\n' }] });
    });
  });
});
