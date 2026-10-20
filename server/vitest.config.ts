import { defineConfig } from 'vitest/config';

// Tests run against a separate database (TEST_DATABASE_URL), migrated and seeded with demo data before the run.
const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://policydesk:policydesk@127.0.0.1:5432/policydesk_test';

export default defineConfig({
  test: {
    globalSetup: './test/global-setup.ts',
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DB,
      JWT_SECRET: 'test-secret-not-for-production',
      CLIENT_ORIGIN: 'http://localhost:5173',
      // Only what's needed to check webhook signatures. No provider keys, so nothing is ever sent.
      PUBLIC_API_URL: 'https://crm.test',
      TWILIO_AUTH_TOKEN: 'test-twilio-auth-token',
      SENDGRID_INBOUND_KEY: 'test-inbound-key',
    },
  },
});
