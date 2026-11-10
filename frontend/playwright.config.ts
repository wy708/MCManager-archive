import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: { locale: 'zh-CN', baseURL: 'http://127.0.0.1:5174', trace: 'retain-on-failure' },
  reporter: 'list',
  webServer: [
    {
      command:
        process.platform === 'win32'
          ? 'mvnw.cmd -B -ntp spring-boot:run'
          : 'sh ./mvnw -B -ntp spring-boot:run',
      cwd: '../backend',
      url: 'http://127.0.0.1:18080/api/health',
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        MCM_PORT: '18080',
        MCM_BIND_ADDRESS: '127.0.0.1',
        MCM_ADMIN_USERNAME: 'admin',
        MCM_ADMIN_PASSWORD: 'e2e-admin-password-2026',
        MCM_DB_URL: 'jdbc:h2:mem:e2e;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1',
        MCM_DB_USER: 'sa',
        MCM_DB_PASSWORD: '',
        MCM_COOKIE_SECURE: 'false',
        MCM_BACKUP_POLICY_WORKER_ENABLED: 'false',
        MCM_BACKUP_DIR: '../.tools/browser-backup-store',
      },
    },
    {
      command: 'npm run dev -- --port 5174',
      url: 'http://127.0.0.1:5174',
      timeout: 30_000,
      reuseExistingServer: false,
      env: { MCM_API_TARGET: 'http://127.0.0.1:18080' },
    },
  ],
})
