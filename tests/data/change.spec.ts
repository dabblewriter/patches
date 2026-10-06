import { afterEach, describe, expect, it } from 'vitest';
import { createChange, getChangeClientVersion, setChangeClientVersion } from '../../src/data/change.js';

describe('createChange — clientVersion stamp', () => {
  afterEach(() => setChangeClientVersion(undefined));

  it('omits the field entirely until the app sets a version', () => {
    expect(getChangeClientVersion()).toBeUndefined();
    expect(createChange([{ op: 'add', path: '/a', value: 1 }])).not.toHaveProperty('clientVersion');
    expect(createChange(0, 1, [{ op: 'add', path: '/a', value: 1 }])).not.toHaveProperty('clientVersion');
  });

  it('stamps every change minted after the app sets one, in both forms', () => {
    setChangeClientVersion('3.0.82');

    expect(createChange([{ op: 'add', path: '/a', value: 1 }]).clientVersion).toBe('3.0.82');
    expect(createChange(0, 1, [{ op: 'add', path: '/a', value: 1 }]).clientVersion).toBe('3.0.82');
    expect(getChangeClientVersion()).toBe('3.0.82');
  });

  it('lets an explicit version in metadata win over the running one', () => {
    setChangeClientVersion('3.0.82');

    const split = createChange(0, 1, [{ op: 'add', path: '/a', value: 1 }], { clientVersion: '3.0.60' });

    expect(split.clientVersion).toBe('3.0.60');
  });

  it('stops stamping when the version is cleared', () => {
    setChangeClientVersion('3.0.82');
    setChangeClientVersion(undefined);

    expect(createChange(0, 1, [{ op: 'add', path: '/a', value: 1 }])).not.toHaveProperty('clientVersion');
  });
});
