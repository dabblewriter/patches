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
    // Scope any HTTP-level failure to the request that was sent, so it rejects
    // that call instead of orphaning it or poisoning unrelated in-flight calls.
    const emitError = (code: number, message: string) => {
      const request = JSON.parse(raw) as JsonRpcRequest;
      this.onMessage.emit(JSON.stringify(rpcError(code, message, undefined, request.id)));
    };

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.authHeader) headers['Authorization'] = this.authHeader;
      if (extraHeaders) Object.assign(headers, extraHeaders);

      const response = await globalThis.fetch(this.url, {
        method: 'POST',
        headers,
        body: raw,
      });
      const body = await response.text();
      if (!response.ok) {
        emitError(response.status, `HTTP ${response.status}: ${body.slice(0, 200)}`);
        return;
      }
      this.onMessage.emit(body);
    } catch (error) {
      emitError(-32000, (error as Error).message);
    }
  }
}
