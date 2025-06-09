import { describe, it, expect, vi } from 'vitest';
import {
  allowAll,
  denyAll,
  type AuthorizationProvider,
  type AuthContext,
  type Access,
} from '../../../src/net/websocket/AuthorizationProvider';

describe('AuthorizationProvider', () => {
  describe('allowAll provider', () => {
    it('should allow all access attempts', () => {
      const ctx: AuthContext = { clientId: 'test-client' };

      expect(allowAll.canAccess(ctx, 'doc1', 'read', 'getDoc')).toBe(true);
      expect(allowAll.canAccess(ctx, 'doc2', 'write', 'commitChanges')).toBe(true);
      expect(allowAll.canAccess(undefined, 'doc3', 'read', 'subscribe')).toBe(true);
    });

    it('should allow access with any parameters', () => {
      expect(allowAll.canAccess(undefined, '', 'read', '')).toBe(true);
      expect(allowAll.canAccess({}, 'any-doc', 'write', 'any-method', {})).toBe(true);
    });

    it('should work with custom auth context types', () => {
      interface CustomAuthContext extends AuthContext {
        userId: string;
        permissions: string[];
      }

      const customCtx: CustomAuthContext = {
        clientId: 'client1',
        userId: 'user123',
        permissions: ['read', 'write'],
      };

      expect(allowAll.canAccess(customCtx, 'doc1', 'read', 'getDoc')).toBe(true);
    });
  });

  describe('denyAll provider', () => {
    it('should deny all access attempts', () => {
      const ctx: AuthContext = { clientId: 'test-client' };

      expect(denyAll.canAccess(ctx, 'doc1', 'read', 'getDoc')).toBe(false);
      expect(denyAll.canAccess(ctx, 'doc2', 'write', 'commitChanges')).toBe(false);
      expect(denyAll.canAccess(undefined, 'doc3', 'read', 'subscribe')).toBe(false);
    });

    it('should log warning when denying access', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const ctx: AuthContext = { clientId: 'test-client' };
      const result = denyAll.canAccess(ctx, 'doc1', 'read', 'getDoc');

      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        'Authorization check failed: No authorization provider configured. Access denied.'
      );

      consoleSpy.mockRestore();
    });

    it('should deny access regardless of parameters', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(denyAll.canAccess(undefined, '', 'read', '')).toBe(false);
      expect(denyAll.canAccess({}, 'any-doc', 'write', 'any-method', {})).toBe(false);

      consoleSpy.mockRestore();
    });

    it('should work with custom auth context types', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      interface CustomAuthContext extends AuthContext {
        userId: string;
        permissions: string[];
      }

      const customCtx: CustomAuthContext = {
        clientId: 'client1',
        userId: 'user123',
        permissions: ['read', 'write'],
      };

      expect(denyAll.canAccess(customCtx, 'doc1', 'read', 'getDoc')).toBe(false);

      consoleSpy.mockRestore();
    });
  });

  describe('Access type', () => {
    it('should define read and write access levels', () => {
      const readAccess: Access = 'read';
      const writeAccess: Access = 'write';

      expect(readAccess).toBe('read');
      expect(writeAccess).toBe('write');
    });
  });

  describe('AuthContext interface', () => {
    it('should support optional clientId', () => {
      const ctx1: AuthContext = {};
      const ctx2: AuthContext = { clientId: 'test-client' };

      expect(ctx1.clientId).toBeUndefined();
      expect(ctx2.clientId).toBe('test-client');
    });

    it('should support additional properties', () => {
      const ctx: AuthContext = {
        clientId: 'test-client',
        userId: 'user123',
        roles: ['admin', 'editor'],
        sessionId: 'session456',
      };

      expect(ctx.clientId).toBe('test-client');
      expect(ctx.userId).toBe('user123');
      expect(ctx.roles).toEqual(['admin', 'editor']);
      expect(ctx.sessionId).toBe('session456');
    });
  });

  describe('Custom AuthorizationProvider implementations', () => {
    it('should support synchronous providers', () => {
      const syncProvider: AuthorizationProvider = {
        canAccess: (ctx, docId, kind, method, params) => {
          return ctx?.clientId === 'authorized-client' && kind === 'read';
        },
      };

      const authorizedCtx: AuthContext = { clientId: 'authorized-client' };
      const unauthorizedCtx: AuthContext = { clientId: 'unauthorized-client' };

      expect(syncProvider.canAccess(authorizedCtx, 'doc1', 'read', 'getDoc')).toBe(true);
      expect(syncProvider.canAccess(authorizedCtx, 'doc1', 'write', 'commitChanges')).toBe(false);
      expect(syncProvider.canAccess(unauthorizedCtx, 'doc1', 'read', 'getDoc')).toBe(false);
    });

    it('should support asynchronous providers', async () => {
      const asyncProvider: AuthorizationProvider = {
        canAccess: async (ctx, docId, kind, method, params) => {
          // Simulate async authorization check (e.g., database lookup)
          await new Promise(resolve => setTimeout(resolve, 1));
          return ctx?.clientId === 'async-authorized' && docId === 'allowed-doc';
        },
      };

      const authorizedCtx: AuthContext = { clientId: 'async-authorized' };
      const unauthorizedCtx: AuthContext = { clientId: 'async-unauthorized' };

      await expect(asyncProvider.canAccess(authorizedCtx, 'allowed-doc', 'read', 'getDoc')).resolves.toBe(true);
      await expect(asyncProvider.canAccess(authorizedCtx, 'forbidden-doc', 'read', 'getDoc')).resolves.toBe(false);
      await expect(asyncProvider.canAccess(unauthorizedCtx, 'allowed-doc', 'read', 'getDoc')).resolves.toBe(false);
    });

    it('should support method-specific authorization', () => {
      const methodProvider: AuthorizationProvider = {
        canAccess: (ctx, docId, kind, method, params) => {
          if (method === 'deleteDoc') {
            return ctx?.clientId === 'admin';
          }
          if (method === 'commitChanges') {
            return ctx?.clientId === 'editor' || ctx?.clientId === 'admin';
          }
          return true; // Allow all other methods
        },
      };

      const adminCtx: AuthContext = { clientId: 'admin' };
      const editorCtx: AuthContext = { clientId: 'editor' };
      const viewerCtx: AuthContext = { clientId: 'viewer' };

      // Delete permissions
      expect(methodProvider.canAccess(adminCtx, 'doc1', 'write', 'deleteDoc')).toBe(true);
      expect(methodProvider.canAccess(editorCtx, 'doc1', 'write', 'deleteDoc')).toBe(false);
      expect(methodProvider.canAccess(viewerCtx, 'doc1', 'write', 'deleteDoc')).toBe(false);

      // Commit permissions
      expect(methodProvider.canAccess(adminCtx, 'doc1', 'write', 'commitChanges')).toBe(true);
      expect(methodProvider.canAccess(editorCtx, 'doc1', 'write', 'commitChanges')).toBe(true);
      expect(methodProvider.canAccess(viewerCtx, 'doc1', 'write', 'commitChanges')).toBe(false);

      // Other methods
      expect(methodProvider.canAccess(viewerCtx, 'doc1', 'read', 'getDoc')).toBe(true);
    });

    it('should support parameter-based authorization', () => {
      const paramProvider: AuthorizationProvider = {
        canAccess: (ctx, docId, kind, method, params) => {
          if (method === 'commitChanges' && params?.changes) {
            // Only allow small changesets
            return params.changes.length <= 5;
          }
          return true;
        },
      };

      const ctx: AuthContext = { clientId: 'test-client' };

      // Small changeset - allowed
      expect(
        paramProvider.canAccess(ctx, 'doc1', 'write', 'commitChanges', {
          changes: [1, 2, 3],
        })
      ).toBe(true);

      // Large changeset - denied
      expect(
        paramProvider.canAccess(ctx, 'doc1', 'write', 'commitChanges', {
          changes: [1, 2, 3, 4, 5, 6, 7],
        })
      ).toBe(false);

      // No params - allowed
      expect(paramProvider.canAccess(ctx, 'doc1', 'write', 'commitChanges')).toBe(true);

      // Other methods - allowed
      expect(paramProvider.canAccess(ctx, 'doc1', 'read', 'getDoc')).toBe(true);
    });

    it('should handle provider errors gracefully', () => {
      const errorProvider: AuthorizationProvider = {
        canAccess: (ctx, docId, kind, method, params) => {
          throw new Error('Authorization service unavailable');
        },
      };

      const ctx: AuthContext = { clientId: 'test-client' };

      expect(() => {
        errorProvider.canAccess(ctx, 'doc1', 'read', 'getDoc');
      }).toThrow('Authorization service unavailable');
    });

    it('should handle async provider errors gracefully', async () => {
      const asyncErrorProvider: AuthorizationProvider = {
        canAccess: async (ctx, docId, kind, method, params) => {
          throw new Error('Async authorization service unavailable');
        },
      };

      const ctx: AuthContext = { clientId: 'test-client' };

      await expect(asyncErrorProvider.canAccess(ctx, 'doc1', 'read', 'getDoc')).rejects.toThrow(
        'Async authorization service unavailable'
      );
    });
  });

  describe('Type safety', () => {
    it('should enforce AuthorizationProvider interface', () => {
      // This test verifies TypeScript compilation
      const provider: AuthorizationProvider = {
        canAccess: (ctx, docId, kind, method, params) => true,
      };

      expect(typeof provider.canAccess).toBe('function');
    });

    it('should support generic AuthContext types', () => {
      interface CustomAuthContext extends AuthContext {
        organizationId: string;
        permissions: Set<string>;
      }

      const typedProvider: AuthorizationProvider<CustomAuthContext> = {
        canAccess: (ctx, docId, kind, method, params) => {
          return ctx ? ctx.permissions.has(kind) && docId.startsWith(ctx.organizationId) : false;
        },
      };

      const ctx: CustomAuthContext = {
        clientId: 'client1',
        organizationId: 'org123',
        permissions: new Set(['read', 'write']),
      };

      expect(typedProvider.canAccess(ctx, 'org123-doc1', 'read', 'getDoc')).toBe(true);
      expect(typedProvider.canAccess(ctx, 'org456-doc1', 'read', 'getDoc')).toBe(false);
    });
  });
});
