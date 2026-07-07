import { describe, expect, it } from 'vitest';
import { applyPatch } from '../../src/json-patch/applyPatch.js';
import { filterSoftWritesAgainstState } from '../../src/json-patch/utils/softWrites.js';

/**
 * Soft semantics for ARRAY-INDEX paths.
 *
 * Soft ops exist so initialization writes never clobber existing data. For object
 * member paths, "path exists in state" is the right skip condition. For an
 * array-index path it is not: RFC 6902 `add` at an occupied array index is an
 * INSERT (splice), which never overwrites anything, and `'2' in array` only means
 * "the array has 3+ elements" — it says nothing about whether the seeded VALUE is
 * already present.
 *
 * Real-world failure (dabble-next, projects_content/zngNpwHzMwfgrtmq rev 2687,
 * created Oct 2023 by the Dabble 2 client, imported by the v2→v3 bridge):
 *
 *   [{ op: 'add', path: '/docs/templates',  value: {...}, soft: true },
 *    { op: 'add', path: '/docs/characters', value: {...}, soft: true },
 *    { op: 'add', path: '/children/2', value: 'characters', soft: true }]
 *
 * The two object-path seeds behave correctly; the `/children/2` insert is dropped
 * for every project whose `children` already has 3+ entries — i.e. all of them —
 * leaving `docs.characters` orphaned with no nav reference (the missing
 * Characters section in migrated pre-Oct-2023 projects; healed product-side by
 * dabble-writer-3.0 healNovelSections).
 *
 * These tests assert the DESIRED semantics for soft array-index adds: skip only
 * when the seeded value is already present in the array, insert otherwise. They
 * FAIL against current behaviour ("skip whenever the index is occupied") and
 * document the bug. Do not "fix" them by asserting current behaviour — see the
 * rollout analysis before changing apply semantics: applyPatch runs during OT
 * replay on pup and every client, so this change alters the materialized state
 * of existing stored histories.
 */
describe('soft ops at array-index paths', () => {
  describe('applyPatch', () => {
    it('inserts a soft add at an occupied index when the value is not in the array', () => {
      const result = applyPatch({ list: ['a', 'b', 'c'] }, [{ op: 'add', path: '/list/1', value: 'x', soft: true }]);
      expect(result).toEqual({ list: ['a', 'x', 'b', 'c'] });
    });

    it('skips a soft add when the value already exists in the array', () => {
      // Passes today, but for the wrong reason (index occupied, not value present).
      const result = applyPatch({ list: ['a', 'x', 'b'] }, [{ op: 'add', path: '/list/2', value: 'x', soft: true }]);
      expect(result).toEqual({ list: ['a', 'x', 'b'] });
    });

    it('applies the real-world v2 Characters-section seed (rev 2687 shape)', () => {
      const state = {
        children: ['plot', 'manuscript', 'notes'],
        docs: {
          plot: { id: 'plot', type: 'plot' },
          manuscript: { id: 'manuscript', type: 'manuscript' },
          notes: { id: 'notes', type: 'notes' },
        },
      };
      const ops = [
        { op: 'add', path: '/docs/templates', value: { id: 'templates', type: 'templates', children: [] }, soft: true },
        {
          op: 'add',
          path: '/docs/characters',
          value: { id: 'characters', type: 'characters', children: [] },
          soft: true,
        },
        { op: 'add', path: '/children/2', value: 'characters', soft: true },
      ];
      const result = applyPatch(state, ops);
      // Object-path seeds work today; the array insert is silently dropped,
      // orphaning docs.characters from the nav tree.
      expect(result.docs.characters).toEqual({ id: 'characters', type: 'characters', children: [] });
      expect(result.children).toEqual(['plot', 'manuscript', 'characters', 'notes']);
    });

    it('is idempotent when the seed replays after it already applied', () => {
      const state = {
        children: ['plot', 'manuscript', 'characters', 'notes'],
        docs: { characters: { id: 'characters', type: 'characters', children: [] } },
      };
      const result = applyPatch(state, [{ op: 'add', path: '/children/2', value: 'characters', soft: true }]);
      expect(result.children).toEqual(['plot', 'manuscript', 'characters', 'notes']);
    });

    it('inserts an implicit-soft empty container at an occupied index', () => {
      // Empty-container adds are soft by convention to let map initializations
      // merge. At an array index nothing can be overwritten — inserting an empty
      // row into a grid must not be dropped just because the slot is occupied.
      const result = applyPatch({ rows: [[1], [2]] }, [{ op: 'add', path: '/rows/1', value: [] }]);
      expect(result).toEqual({ rows: [[1], [], [2]] });
    });

    // Characterization: append forms already behave (the path "doesn't exist"),
    // documenting that only occupied-index inserts are affected.
    it('applies a soft append via "-" (passes today)', () => {
      const result = applyPatch({ list: ['a'] }, [{ op: 'add', path: '/list/-', value: 'b', soft: true }]);
      expect(result).toEqual({ list: ['a', 'b'] });
    });

    it('applies a soft add at index === length (passes today)', () => {
      const result = applyPatch({ list: ['a'] }, [{ op: 'add', path: '/list/1', value: 'b', soft: true }]);
      expect(result).toEqual({ list: ['a', 'b'] });
    });
  });

  describe('filterSoftWritesAgainstState', () => {
    it('keeps a soft array-index add when the value is not in the array', () => {
      const ops = [{ op: 'add', path: '/children/2', value: 'characters', soft: true }];
      const filtered = filterSoftWritesAgainstState(ops, { children: ['plot', 'manuscript', 'notes'] });
      expect(filtered).toEqual(ops);
    });

    it('drops a soft array-index add when the value is already in the array', () => {
      // Passes today for the wrong reason (index occupied).
      const ops = [{ op: 'add', path: '/children/2', value: 'characters', soft: true }];
      const filtered = filterSoftWritesAgainstState(ops, { children: ['plot', 'manuscript', 'characters'] });
      expect(filtered).toEqual([]);
    });
  });
});
