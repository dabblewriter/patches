import { signal } from '../../event-signal.js';
import type { ClientTransport, JsonRpcRequest } from '../protocol/types.js';
import { rpcError } from '../protocol/utils.js';

/**
 * Transport that uses fetch to send and receive messages.
 */
export class FetchTransport implements ClientTransport {
  public readonly onMessage = signal<(raw: string) => void>();
  private headers: Record<string, string> | undefined;

  constructor(
    private url: string,
    private authHeader: string
  ) {}

  addHeadersToNextCall(headers: Record<string, string>): void {
    this.headers = headers;
  }

  async send(raw: string): Promise<void> {
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.authHeader,
          ...this.headers,
        },
        body: raw,
      });
      this.headers = undefined;
      this.onMessage.emit(await response.text());
    } catch (error) {
      // ensure the error is associated with the request that was sent
      const message = JSON.parse(raw) as JsonRpcRequest;
      this.onMessage.emit(JSON.stringify(rpcError(-32000, (error as Error).message, message.id)));
    }
  }
}
