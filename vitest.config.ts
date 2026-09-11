import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Integration tests hit the live project and share one running-timer slot,
    // so they must not run concurrently with each other.
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
})
