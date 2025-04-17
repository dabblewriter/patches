import { describe, expect, it, vi } from 'vitest';
import { AbstractTransport } from '../../src/net/AbstractTransport';
import type { ConnectionState } from '../../src/net/protocol/types';

// Create a concrete implementation of AbstractTransport for testing
class TestTransport extends AbstractTransport {
  private _connectImpl = vi.fn().mockResolvedValue(undefined);
  private _disconnectImpl = vi.fn();
  private _sendImpl = vi.fn();

  // Force the state to change for testing purposes
  public changeState(state: ConnectionState): void {
    this.state = state;
  }

  // Implementation of abstract methods
  async connect(): Promise<void> {
    return this._connectImpl();
  }

  disconnect(): void {
    this._disconnectImpl();
  }

  send(data: string): void {
    this._sendImpl(data);
  }
}

describe('AbstractTransport', () => {
  it('should initialize with disconnected state', () => {
    const transport = new TestTransport();
    expect(transport.state).toBe('disconnected');
  });

  it('should emit state change events when state changes', () => {
    const transport = new TestTransport();
    const stateChangeHandler = vi.fn();

    // Register state change handler
    transport.onStateChange(stateChangeHandler);

    // Change state
    transport.changeState('connecting');
    expect(stateChangeHandler).toHaveBeenCalledWith('connecting');

    // Change to another state
    transport.changeState('connected');
    expect(stateChangeHandler).toHaveBeenCalledWith('connected');

    // Change to error state
    transport.changeState('error');
    expect(stateChangeHandler).toHaveBeenCalledWith('error');

    // Change back to disconnected
    transport.changeState('disconnected');
    expect(stateChangeHandler).toHaveBeenCalledWith('disconnected');

    // Verify total calls
    expect(stateChangeHandler).toHaveBeenCalledTimes(4);
  });

  it('should emit message events via the onMessage signal', () => {
    const transport = new TestTransport();
    const messageHandler = vi.fn();

    // Register message handler
    transport.onMessage(messageHandler);

    // Simulate receiving a message
    const testMessage = '{"type":"test","data":"value"}';
    transport.onMessage.emit(testMessage);

    // Verify handler was called with the message
    expect(messageHandler).toHaveBeenCalledWith(testMessage);
  });

  it('should support multiple state change listeners', () => {
    const transport = new TestTransport();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    // Register multiple handlers
    transport.onStateChange(handler1);
    transport.onStateChange(handler2);

    // Change state
    transport.changeState('connecting');

    // Both handlers should be called
    expect(handler1).toHaveBeenCalledWith('connecting');
    expect(handler2).toHaveBeenCalledWith('connecting');
  });

  it('should support multiple message listeners', () => {
    const transport = new TestTransport();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    // Register multiple handlers
    transport.onMessage(handler1);
    transport.onMessage(handler2);

    // Emit a message
    const testMessage = 'test message';
    transport.onMessage.emit(testMessage);

    // Both handlers should be called
    expect(handler1).toHaveBeenCalledWith(testMessage);
    expect(handler2).toHaveBeenCalledWith(testMessage);
  });
});
