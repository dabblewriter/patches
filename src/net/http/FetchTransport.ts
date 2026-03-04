import { signal } from 'easy-signal';
import type { ClientTransport, JsonRpcRequest } from '../protocol/types.js';
import { rpcError } from '../protocol/utils.js';

/**
 * Transport that uses fetch to send and receive messages.
 */
export class FetchTransport implements ClientTransport {
  public readonly onMessage = signal<(raw: string) => void>();

  constructor(
    private url: string,
    private authHeader: string
  ) {}

  async send(raw: string, extraHeaders?: Record<string, string>): Promise<void> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.authHeader) headers['Authorization'] = this.authHeader;
      if (extraHeaders) Object.assign(headers, extraHeaders);

      const response = await globalThis.fetch(this.url, {
        method: 'POST',
        headers,
        body: raw,
      });
      this.onMessage.emit(await response.text());
    } catch (error) {
      // ensure the error is associated with the request that was sent
      const message = JSON.parse(raw) as JsonRpcRequest;
      this.onMessage.emit(JSON.stringify(rpcError(-32000, (error as Error).message, undefined, message.id)));
    }
  }
}
