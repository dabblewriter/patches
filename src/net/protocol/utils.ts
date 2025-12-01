import type { JsonRpcNotification, JsonRpcResponse } from './types';

export function rpcResponse<T = any>(result: T, id?: number): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? (null as any), result };
}

export function rpcError(code: number, message: string, data?: any, id?: number): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? (null as any), error: { code, message, data } };
}

export function rpcNotification(method: string, params?: any): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params };
}
