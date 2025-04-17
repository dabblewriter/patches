import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'net/index': resolve(__dirname, 'src/net/index.ts'),
        'server/index': resolve(__dirname, 'src/server/index.ts'),
        'persist/index': resolve(__dirname, 'src/persist/index.ts'),
        'client/index': resolve(__dirname, 'src/client/index.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['@dabble/delta', 'crypto-id', 'simple-peer', 'alphacounter'],
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
      },
    },
  },
  plugins: [
    dts({
      include: ['src'],
      exclude: ['**/*.test.ts', '**/*.spec.ts'],
      compilerOptions: {
        declaration: true,
        declarationMap: true,
      },
    }),
  ],
});
