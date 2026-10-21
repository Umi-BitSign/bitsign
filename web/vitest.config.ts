import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    main: './worker/index.ts',
    miniflare: {
      compatibilityDate: '2026-10-21',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      r2Buckets: ['VIDEOS'],
      queueProducers: { TRANSLATIONS: 'bitsign-test-translations' },
      durableObjects: { MODEL: { className: 'C5Model', useSQLite: true } },
      bindings: {
        MODEL_ID: '00a74422d9c17a4add1c562bcf54abe4111f26288a33c5168ed458b13b233b91',
        MODEL_NAME: 'Trupan · C5 public model',
        MODEL_LICENSE: 'CC-BY-SA-4.0',
        MAX_UPLOAD_BYTES: '52428800',
        MAX_DURATION_SECONDS: '30',
        INFERENCE_ENABLED: 'true',
        TEST_MIGRATIONS: await readD1Migrations('./migrations'),
      },
    },
  })],
  test: { include: ['test/worker*.test.ts'], fileParallelism: false },
});
