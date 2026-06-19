import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The generated protobuf-ts codec is covered at the PROTOCOL level by
      // test/ws-protocol-matrix.test.ts (every command/server-msg round-trips),
      // not by line count of 15k generated lines. Barrels and scripts re-export
      // only. Everything hand-written stays measured.
      exclude: [
        'src/proto/messages.ts',
        'src/proto/index.ts',
        '**/*.d.ts',
      ],
      reporter: ['text-summary', 'text'],
    },
  },
});
