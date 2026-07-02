import { describe, expect, it, vi } from 'vitest';
import type { Patches } from '../../src/client/Patches';
import type { PatchesDoc } from '../../src/client/PatchesDoc';
import { DocManager } from '../../src/shared/doc-manager';

function makePatches(doc: unknown = { id: 'doc1' }) {
  const openDoc = vi.fn().mockResolvedValue(doc as PatchesDoc<any>);
  const closeDoc = vi.fn().mockResolvedValue(undefined);
  const getOpenDoc = vi.fn().mockReturnValue(doc as PatchesDoc<any>);
  const patches = { openDoc, closeDoc, getOpenDoc } as unknown as Patches;
  return { patches, openDoc, closeDoc };
}

describe('DocManager', () => {
  it('closes on the last paired close and not before', async () => {
    const { patches, closeDoc } = makePatches();
    const manager = new DocManager();

    await manager.openDoc(patches, 'doc1');
    await manager.openDoc(patches, 'doc1');
    await manager.closeDoc(patches, 'doc1');
    expect(closeDoc).not.toHaveBeenCalled();

    await manager.closeDoc(patches, 'doc1');
    expect(closeDoc).toHaveBeenCalledTimes(1);
    expect(manager.getRefCount('doc1')).toBe(0);
  });

  // Finding #34: a close issued while the first open is still pending must not be
  // silently dropped — the open establishes the reference right after, leaking the
  // doc (and its sync subscription) forever despite a paired open/close.
  it('honors a close issued while the open is still pending', async () => {
    const doc = { id: 'doc1' };
    const { patches, openDoc, closeDoc } = makePatches(doc);
    let resolveOpen!: (d: unknown) => void;
    openDoc.mockReturnValue(
      new Promise(r => {
        resolveOpen = r;
      })
    );
    const manager = new DocManager();

    const openPromise = manager.openDoc(patches, 'doc1');
    const closePromise = manager.closeDoc(patches, 'doc1'); // during pending open

    resolveOpen(doc);
    await openPromise;
    await closePromise;

    expect(closeDoc).toHaveBeenCalledTimes(1);
    expect(closeDoc).toHaveBeenCalledWith('doc1', { untrack: false });
    expect(manager.getRefCount('doc1')).toBe(0);
  });

  it('keeps the doc open when a second reference arrives during the pending open', async () => {
    const doc = { id: 'doc1' };
    const { patches, openDoc, closeDoc } = makePatches(doc);
    let resolveOpen!: (d: unknown) => void;
    openDoc.mockReturnValue(
      new Promise(r => {
        resolveOpen = r;
      })
    );
    const manager = new DocManager();

    const first = manager.openDoc(patches, 'doc1');
    const second = manager.openDoc(patches, 'doc1'); // concurrent waiter
    const close = manager.closeDoc(patches, 'doc1'); // balances one of them

    resolveOpen(doc);
    await Promise.all([first, second, close]);

    expect(closeDoc).not.toHaveBeenCalled();
    expect(manager.getRefCount('doc1')).toBe(1);
  });

  it('drops a close awaiting an open that fails (no reference was established)', async () => {
    const { patches, openDoc, closeDoc } = makePatches();
    let rejectOpen!: (e: Error) => void;
    openDoc.mockReturnValue(
      new Promise((_, r) => {
        rejectOpen = r;
      })
    );
    const manager = new DocManager();

    const openPromise = manager.openDoc(patches, 'doc1');
    const closePromise = manager.closeDoc(patches, 'doc1');

    rejectOpen(new Error('load failed'));
    await expect(openPromise).rejects.toThrow('load failed');
    await closePromise;

    expect(closeDoc).not.toHaveBeenCalled();
    expect(manager.getRefCount('doc1')).toBe(0);
  });

  it('close on a never-opened doc is a no-op', async () => {
    const { patches, closeDoc } = makePatches();
    const manager = new DocManager();

    await expect(manager.closeDoc(patches, 'nope')).resolves.toBeUndefined();
    expect(closeDoc).not.toHaveBeenCalled();
  });
});
