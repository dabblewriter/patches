import { Delta } from '@dabble/delta';
import { describe, expect, it, vi } from 'vitest';
import { PatchesDoc } from '../../src/client/PatchesDoc.js';
import { JSONPatch } from '../../src/json-patch/JSONPatch.js';

describe('Oversize change handling integration', () => {
  it('should split large text changes into multiple pieces', () => {
    // Create a document with a small max payload size to force splitting
    const doc = new PatchesDoc({}, {}, { maxPayloadBytes: 500 });

    // Set up onChange listener to track emitted changes
    const onChangeSpy = vi.fn();
    doc.onChange(onChangeSpy);

    // Create a large text content that will exceed our maxPayloadBytes
    const largeText = 'Lorem ipsum '.repeat(1000); // Approx 12KB

    // Make a change with a large text delta
    doc.change((draft: any, patch: JSONPatch) => {
      patch.text('/content', new Delta().insert(largeText));
    });

    // onChange should be emitted once with an array containing multiple changes
    expect(onChangeSpy).toHaveBeenCalledTimes(1);
    const emittedChanges: any[] = onChangeSpy.mock.calls[0][0];
    expect(emittedChanges.length).toBeGreaterThan(1);

    // Verify the document state contains the full text
    expect(doc.state).toHaveProperty('content');
    expect((doc.state as any).content.ops[0].insert.includes(largeText.substring(0, 100))).toBe(true);
    expect((doc.state as any).content.ops[0].insert.length).toBeGreaterThanOrEqual(largeText.length);

    // Verify all changes are smaller than the max size
    const pendingChanges = doc.getPendingChanges();
    expect(pendingChanges.length).toBeGreaterThan(1);

    // Each individual change should be under the limit
    for (const change of pendingChanges) {
      const size = new TextEncoder().encode(JSON.stringify(change)).length;
      expect(size).toBeLessThanOrEqual(500);
    }
  });

  it('should handle copying large document content', () => {
    // Create a document with a complex state that will result in a large change
    const complexInitialState = {
      title: 'Test Document',
      sections: Array(50)
        .fill(null)
        .map((_, i) => ({
          id: `section-${i}`,
          title: `Section ${i}`,
          content: `Content for section ${i}. ${i % 2 === 0 ? 'Even section.' : 'Odd section.'}`,
        })),
      metadata: {
        created: Date.now(),
        tags: ['test', 'large', 'document'],
        owner: 'test-user',
        permissions: { read: ['user1', 'user2'], write: ['user1'] },
      },
    };

    const doc = new PatchesDoc(complexInitialState, {}, { maxPayloadBytes: 1000 });

    // Set up onChange listener
    const onChangeSpy = vi.fn();
    doc.onChange(onChangeSpy);

    // Make a change that duplicates/copies large parts of the document
    doc.change((draft: any, patch: JSONPatch) => {
      // Copy all the sections to a new property (creates a large change)
      draft.copiedSections = [...draft.sections];

      // Also add some text content
      patch.text('/textContent', new Delta().insert('Some additional text content'));
    });

    // onChange should emit once with multiple changes
    expect(onChangeSpy).toHaveBeenCalledTimes(1);
    const emittedChanges2: any[] = onChangeSpy.mock.calls[0][0];
    expect(emittedChanges2.length).toBeGreaterThan(1);

    // Verify state has both the copied sections and text content
    expect(doc.state).toHaveProperty('copiedSections');
    expect(doc.state).toHaveProperty('textContent');
    expect((doc.state as any).copiedSections.length).toBe(50);

    // Each individual change should be under the limit
    const pendingChanges2 = doc.getPendingChanges();
    for (const change of pendingChanges2) {
      const size = new TextEncoder().encode(JSON.stringify(change)).length;
      expect(size).toBeLessThanOrEqual(1000);
    }
  });

  it('should preserve metadata across split changes', () => {
    // Create a doc with custom metadata
    const metadata = { user: 'test-user', sessionId: 'abc123', source: 'paste-event' };
    const doc = new PatchesDoc({}, metadata, { maxPayloadBytes: 500 });

    // Make a large change
    const largeText = 'X'.repeat(5000);
    doc.change((draft: any, patch: JSONPatch) => {
      patch.text('/content', new Delta().insert(largeText));
    });

    // Verify metadata is preserved in all split changes
    const pendingChanges3 = doc.getPendingChanges();
    expect(pendingChanges3.length).toBeGreaterThan(1);

    for (const change of pendingChanges3) {
      expect(change).toMatchObject(metadata);
    }
  });

  it('should not split when maxPayloadBytes is not specified', () => {
    // Create a doc without specifying maxPayloadBytes
    const doc = new PatchesDoc({});

    // Set up onChange listener
    const onChangeSpy = vi.fn();
    doc.onChange(onChangeSpy);

    // Create a large text content
    const largeText = 'X'.repeat(20000); // 20KB

    // Make the change
    doc.change((draft: any, patch: JSONPatch) => {
      patch.text('/content', new Delta().insert(largeText));
    });

    // Without maxPayloadBytes, this shouldn't split
    expect(onChangeSpy).toHaveBeenCalledTimes(1);
    const emittedChanges: any[] = onChangeSpy.mock.calls[0][0];
    expect(emittedChanges.length).toBe(1);
    expect(doc.getPendingChanges().length).toBe(1);
  });
});
