/**
 * Creates a ReadableStream that emits a single string chunk.
 */
export function jsonReadable(json: string): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      controller.enqueue(json);
      controller.close();
    },
  });
}

/**
 * Concatenates strings and ReadableStreams into a single ReadableStream.
 * Each source is consumed in order. Backpressure propagates naturally:
 * each stream source is only read when the previous one has been fully consumed.
 */
export function concatStreams(...sources: (string | ReadableStream<string>)[]): ReadableStream<string> {
  let index = 0;
  let currentReader: ReadableStreamDefaultReader<string> | null = null;

  return new ReadableStream<string>({
    async pull(controller) {
      while (index < sources.length) {
        const source = sources[index];

        if (typeof source === 'string') {
          controller.enqueue(source);
          index++;
          return;
        }

        // Stream source
        if (!currentReader) {
          currentReader = source.getReader();
        }

        const { done, value } = await currentReader.read();
        if (!done) {
          controller.enqueue(value!);
          return;
        }

        // Stream exhausted, move to next source
        currentReader = null;
        index++;
      }

      controller.close();
    },

    cancel(reason) {
      // Cancel the current reader if open
      if (currentReader) {
        currentReader.cancel(reason);
      }
      // Cancel current (if not yet opened) and all remaining unread streams
      const start = currentReader ? index + 1 : index;
      for (let i = start; i < sources.length; i++) {
        const s = sources[i];
        if (typeof s !== 'string') {
          s.cancel(reason);
        }
      }
    },
  });
}

/**
 * Parses a version state from store format (string or ReadableStream) into a JS object.
 * Only use in non-hot-path code (explicit operations like captureCurrentVersion, createBranch).
 */
export async function parseVersionState(raw: string | ReadableStream<string>): Promise<any> {
  const json = typeof raw === 'string' ? raw : await readStreamAsString(raw);
  return JSON.parse(json);
}

/**
 * Consumes a ReadableStream<string> into a single string.
 * Only use in non-hot-path code (explicit operations like captureCurrentVersion).
 */
export async function readStreamAsString(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks.join('');
}
