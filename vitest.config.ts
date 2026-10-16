import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // @deepseek-ai/dsh-tools is an optional peer that is not installed here;
      // stub it so the unit tests can inspect tool and toolset definitions.
      // tsc still resolves the real types through tsconfig paths.
      '@deepseek-ai/dsh-tools': fileURLToPath(new URL('./tests/stubs/dsh-tools.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
  },
})
