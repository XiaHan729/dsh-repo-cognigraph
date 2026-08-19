import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      // 源级解析：测试直接跑 src（含 .ts 扩展导入）
      '@dsh-external/dsh-repo-cognigraph': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
