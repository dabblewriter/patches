import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthContext, setAuthContext } from '../../src/net/serverContext';
import { OTServer } from '../../src/server/OTServer';
import type { ArrayIndexNormalization, CommitChangesOptions } from '../../src/types';
import { OTFuzzBackend } from '../fuzz/otFuzzBackend';

const DOC = 'projects/p1/content';
const change = (id: string, baseRev: number, ops: any[]) => ({ id, baseRev, ops, createdAt: Date.now() });

async function seeded(options?: ConstructorParameters<typeof OTServer>[1]) {
  const store = new OTFuzzBackend();
  const server = new OTServer(store, options);
  await server.commitChanges(DOC, [change('seed', 0, [{ op: 'add', path: '/list', value: ['a', 'b'] }])]);
  return { store, server };
}

describe('OTServer — array-index normalization wiring (DAB-1557)', () => {
  afterEach(() => clearAuthContext());

  it('emits every correction with the committing clientId', async () => {
    const { server } = await seeded();
    const heard = vi.fn();
    server.onArrayIndicesNormalized(heard);

    setAuthContext({ clientId: 'conn-7' } as any);
    const { changes } = await server.commitChanges(DOC, [
      change('c1', 1, [{ op: 'add', path: '/list/5', value: 'x' }]),
    ]);

    expect(changes.at(-1)!.ops[0].path).toBe('/list/2');
    expect(heard).toHaveBeenCalledTimes(1);
    const [docId, normalizations, clientId] = heard.mock.calls[0] as [string, ArrayIndexNormalization[], string];
    expect(docId).toBe(DOC);
    expect(normalizations).toMatchObject([{ change: { id: 'c1' }, action: 'clamped', index: 5, length: 2 }]);
    expect(clientId).toBe('conn-7');
  });

  it('ignores a client-supplied switch-off and callback', async () => {
    const { server } = await seeded();
    const injected = vi.fn();
    const heard = vi.fn();
    server.onArrayIndicesNormalized(heard);

    const clientOptions: CommitChangesOptions = { normalizeArrayIndices: false, onArrayIndicesNormalized: injected };
    const { changes } = await server.commitChanges(
      DOC,
      [change('c1', 1, [{ op: 'add', path: '/list/9', value: 'x' }])],
      clientOptions
    );

    expect(changes.at(-1)!.ops[0].path).toBe('/list/2');
    expect(injected).not.toHaveBeenCalled();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('commits unchecked when the SERVER option turns it off', async () => {
    const { server } = await seeded({ normalizeArrayIndices: false });
    const heard = vi.fn();
    server.onArrayIndicesNormalized(heard);

    const { changes } = await server.commitChanges(DOC, [
      change('c1', 1, [{ op: 'add', path: '/list/9', value: 'x' }]),
    ]);

    expect(changes.at(-1)!.ops[0].path).toBe('/list/9');
    expect(heard).not.toHaveBeenCalled();
  });

  it('never fails a commit when a listener throws', async () => {
    const { server } = await seeded();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    server.onArrayIndicesNormalized(() => {
      throw new Error('telemetry down');
    });

    const { changes } = await server.commitChanges(DOC, [
      change('c1', 1, [{ op: 'add', path: '/list/5', value: 'x' }]),
    ]);

    expect(changes.at(-1)!.ops[0].path).toBe('/list/2');
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    error.mockRestore();
  });
});
