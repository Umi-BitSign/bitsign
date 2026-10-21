import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, createMessageBatch, createScheduledController, getQueueResult, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { purgeExpired, reconcileJobs } from '../worker';

vi.mock('../examples/catalog.json', () => ({ default: [{
  id: 'paired-example', title: 'Paired example', description: 'The public preview is blurred; inference uses the original source.',
  objectKey: 'private-examples/original.mp4', displayObjectKey: 'display-examples/blurred.mp4', mimeType: 'video/mp4', reference: 'hello',
  attribution: { dataset: 'Test fixture', creator: 'Test creator', url: 'https://example.test', license: 'CC-BY-4.0', licenseUrl: 'https://example.test/license', changes: 'Face blurred for public playback.' },
}] }));

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } } }

const origin = 'https://bitsign.test';
type CreatedJob = { id: string; token: string; status: string };

const preprocessing = (overrides: Record<string, unknown> = {}) => ({
  schema: 'bitsign-video-admission/1', normalized: false,
  inputSha256: '1'.repeat(64), inferenceSha256: '1'.repeat(64), inputBytes: 5, inferenceBytes: 5,
  inputDurationSeconds: 1, inputWidth: 640, inputHeight: 480, inputFps: 30, inputEstimatedFrames: 30,
  width: 640, height: 480, frames: 30, fps: 30, durationSeconds: 1, decodedPixels: 9_216_000,
  maximumDecodedPixels: 350_000_000, maximumFrames: 3600, ...overrides,
});
const success = (text = 'hello', elapsedSeconds = 1.25, receipt = preprocessing()) => Response.json({ text, modelId: env.MODEL_ID, elapsedSeconds, preprocessing: receipt });

function liveRangeShape(stored: R2ObjectBody, range: Record<string, number | undefined>): R2ObjectBody {
  // The observed live shape is broader than R2Range's static union: suffix can
  // be an own property whose value is undefined. Reproduce that exact boundary.
  return new Proxy(stored, { get(target, property) { return property === 'range' ? range : Reflect.get(target, property, target); } });
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`${origin}${path}`, init), env);
}

function videoRequest(ip = '192.0.2.1', bytes = 'video', headers: Record<string, string> = {}): RequestInit {
  return { method: 'POST', headers: { Origin: origin, 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length), 'CF-Connecting-IP': ip, ...headers }, body: bytes };
}

async function create(ip?: string): Promise<CreatedJob> {
  const response = await call('/api/jobs', videoRequest(ip));
  expect(response.status).toBe(202);
  return response.json<CreatedJob>();
}

async function status(job: CreatedJob): Promise<Record<string, unknown>> {
  const response = await call(`/api/jobs/${job.id}`, { headers: { Authorization: `Bearer ${job.token}` } });
  return response.json<Record<string, unknown>>();
}

function mockModel(handler: (request: Request) => Promise<Response> = async () => success()) {
  const stub = env.MODEL.getByName('test-model');
  const fetch = vi.fn(handler);
  vi.spyOn(stub, 'fetch').mockImplementation((input, init) => fetch(new Request(input, init)));
  vi.spyOn(env.MODEL, 'getByName').mockReturnValue(stub);
  return fetch;
}

async function queue(job: CreatedJob, queueName = 'test-translations') {
  const batch = createMessageBatch(queueName, [{ id: crypto.randomUUID(), timestamp: Date.now(), attempts: 1, body: { id: job.id } }]);
  const ctx = createExecutionContext();
  await worker.queue(batch, env);
  return getQueueResult(batch, ctx);
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([env.DB.prepare('DELETE FROM jobs'), env.DB.prepare('DELETE FROM rate_events')]);
  const objects = await env.VIDEOS.list();
  if (objects.objects.length) await env.VIDEOS.delete(objects.objects.map((object) => object.key));
  vi.spyOn(env.TRANSLATIONS, 'send').mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
});

describe('private translation API', () => {
  it('stores only a capability hash, and isolates jobs from another capability', async () => {
    const first = await create();
    const second = await create();
    const row = await env.DB.prepare('SELECT token_hash, object_key FROM jobs WHERE id = ?').bind(first.id).first<{ token_hash: string; object_key: string }>();
    expect(row?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row?.token_hash).not.toBe(first.token);
    expect(row?.object_key).toMatch(/^uploads\/[a-f0-9-]+\/[a-f0-9-]+$/);
    expect((await call(`/api/jobs/${first.id}`)).status).toBe(404);
    expect((await call(`/api/jobs/${first.id}`, { headers: { Authorization: `Bearer ${second.token}` } })).status).toBe(404);
    expect((await status(first)).status).toBe('queued');
    expect((await call(`/api/jobs/${first.id}`, { headers: { Cookie: `bitsign_${first.id}=${first.token}` } })).status).toBe(200);
  });

  it('requires same-origin mutations and uses a private HTTP-only cookie', async () => {
    const response = await call('/api/jobs', videoRequest());
    expect(response.headers.get('Set-Cookie')).toContain('HttpOnly; SameSite=Lax');
    expect(response.headers.get('Set-Cookie')).toContain('Secure');
    const job = await response.json<CreatedJob>();
    const foreign = await call(`/api/jobs/${job.id}`, { method: 'DELETE', headers: { Origin: 'https://elsewhere.test', Authorization: `Bearer ${job.token}` } });
    expect(foreign.status).toBe(403);
    expect((await call('/api/jobs', videoRequest(undefined, 'video', { Origin: 'https://elsewhere.test' }))).status).toBe(403);
    expect((await status(job)).status).toBe('queued');
  });

  it('rejects unsupported, missing-size, oversized and mismatched-size uploads', async () => {
    expect((await call('/api/jobs', videoRequest(undefined, 'video', { 'Content-Type': 'image/png' }))).status).toBe(415);
    expect((await call('/api/jobs', videoRequest(undefined, 'video', { 'Content-Type': 'video/ogg' }))).status).toBe(415);
    expect((await call('/api/jobs', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'video/mp4' }, body: 'video' })).status).toBe(411);
    expect((await call('/api/jobs', videoRequest(undefined, 'video', { 'Content-Length': String(Number(env.MAX_UPLOAD_BYTES) + 1) }))).status).toBe(413);
    expect((await call('/api/jobs', videoRequest(undefined, 'video', { 'Content-Length': '2' }))).status).toBe(413);
    expect((await env.VIDEOS.list()).objects).toHaveLength(0);
  });

  it('rejects arbitrary URL input and unbounded JSON', async () => {
    const request = (body: string): RequestInit => ({ method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body });
    expect((await call('/api/jobs', request(JSON.stringify({ url: 'http://169.254.169.254/' })))).status).toBe(400);
    expect((await call('/api/jobs', request('{bad'))).status).toBe(400);
    expect((await call('/api/jobs', request(' '.repeat(1025)))).status).toBe(413);
    expect((await call('/api/jobs', request(JSON.stringify({ exampleId: 'missing-example' })))).status).toBe(404);
  });

  it('runs an actual queue handler with streaming input and a pinned model response', async () => {
    const job = await create();
    const fetch = mockModel(async (request) => {
      expect(request.method).toBe('POST');
      expect(new TextDecoder().decode(await request.arrayBuffer())).toBe('video');
      return success(' hello ');
    });
    const result = await queue(job);
    expect(result.explicitAcks).toHaveLength(1);
    expect(await status(job)).toMatchObject({ status: 'complete', stage: 'complete', text: ' hello ', elapsedSeconds: 1.25, model: { id: env.MODEL_ID } });
    expect((await env.VIDEOS.list()).objects).toHaveLength(0);
    await queue(job);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('tombstones a running job before deletion, preventing result resurrection', async () => {
    const job = await create();
    let resolveStarted!: () => void;
    let resolveResult!: (response: Response) => void;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const result = new Promise<Response>((resolve) => { resolveResult = resolve; });
    mockModel(async () => { resolveStarted(); return result; });
    const processing = queue(job);
    await started;
    const deleted = await call(`/api/jobs/${job.id}`, { method: 'DELETE', headers: { Origin: origin, Authorization: `Bearer ${job.token}` } });
    expect(deleted.status).toBe(204);
    resolveResult(success('must not persist', 1));
    await processing;
    expect((await call(`/api/jobs/${job.id}`, { headers: { Authorization: `Bearer ${job.token}` } })).status).toBe(404);
    expect(await env.DB.prepare('SELECT status, text, lease_id FROM jobs WHERE id = ?').bind(job.id).first()).toMatchObject({ status: 'deleted', text: null, lease_id: null });
    expect((await env.VIDEOS.list()).objects).toHaveLength(0);
  });

  it('persists retries, then succeeds without creating another job', async () => {
    const job = await create();
    const fetch = mockModel(async () => Response.json({ error: 'private exception detail' }, { status: 503 }));
    const failed = await queue(job);
    expect(failed.retryMessages).toHaveLength(1);
    expect(await status(job)).toMatchObject({ status: 'queued', stage: 'retrying' });
    expect((await env.VIDEOS.list()).objects).toHaveLength(1);
    fetch.mockResolvedValue(success('ready', 0.2));
    await queue(job);
    expect(await status(job)).toMatchObject({ status: 'complete', text: 'ready' });
    expect(await env.DB.prepare('SELECT attempts FROM jobs WHERE id = ?').bind(job.id).first('attempts')).toBe(2);
  });

  it('retries interrupted input cleanup without rerunning completed inference', async () => {
    const job = await create();
    const fetch = mockModel();
    vi.spyOn(env.VIDEOS, 'delete').mockRejectedValueOnce(new Error('temporary storage failure'));
    expect((await queue(job)).retryMessages).toHaveLength(1);
    expect((await status(job)).status).toBe('complete');
    expect((await env.VIDEOS.list()).objects).toHaveLength(1);
    expect((await queue(job)).explicitAcks).toHaveLength(1);
    expect((await env.VIDEOS.list()).objects).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retains validated preprocessing geometry and normalization while excluding runtime-local paths', async () => {
    const job = await create();
    mockModel(async () => success('exact model output', 1.5, preprocessing({
      normalized: true, inferenceSha256: '2'.repeat(64), inferenceBytes: 4,
      inputWidth: 1920, inputHeight: 1080, inputFps: 60, inputEstimatedFrames: 60,
      width: 320, height: 240, decodedPixels: 2_304_000, path: '/private/runtime/input.video',
    })));
    await queue(job);
    expect(await status(job)).toMatchObject({ status: 'complete', text: 'exact model output', preprocessing: {
      normalized: true, inputWidth: 1920, inputHeight: 1080, inputEstimatedFrames: 60, inputDurationSeconds: 1,
      width: 320, height: 240, frames: 30, durationSeconds: 1,
    } });
    const stored = await env.DB.prepare('SELECT preprocessing_json FROM jobs WHERE id = ?').bind(job.id).first<string>('preprocessing_json');
    expect(stored).toContain('"normalized":true');
    expect(stored).not.toContain('/private/runtime');
    expect(JSON.stringify(await status(job))).not.toContain('/private/runtime');
    await call(`/api/jobs/${job.id}`, { method: 'DELETE', headers: { Origin: origin, Authorization: `Bearer ${job.token}` } });
    expect(await env.DB.prepare('SELECT preprocessing_json FROM jobs WHERE id = ?').bind(job.id).first('preprocessing_json')).toBeNull();
  });

  it.each([
    undefined,
    preprocessing({ normalized: 'true' }),
    preprocessing({ decodedPixels: 1 }),
    preprocessing({ inputBytes: 6, inferenceBytes: 6 }),
    preprocessing({ schema: 'unknown-admission-format' }),
  ])('refuses missing or invalid preprocessing evidence: %j', async (receipt) => {
    const job = await create();
    mockModel(async () => Response.json({ text: 'must not become success', modelId: env.MODEL_ID, elapsedSeconds: 1, preprocessing: receipt }));
    await queue(job); await queue(job); await queue(job);
    expect(await status(job)).toMatchObject({ status: 'failed' });
    expect(await status(job)).not.toHaveProperty('text');
    expect(await status(job)).not.toHaveProperty('preprocessing');
    expect((await env.VIDEOS.list()).objects).toHaveLength(0);
  });

  it('preserves historical completed results that predate preprocessing receipts', async () => {
    const job = await create();
    await env.DB.prepare("UPDATE jobs SET status = 'complete', stage = 'complete', text = 'historical output', elapsed_seconds = 1, preprocessing_json = NULL WHERE id = ?").bind(job.id).run();
    await reconcileJobs(env);
    expect(await status(job)).toMatchObject({ status: 'complete', text: 'historical output' });
    expect(await status(job)).not.toHaveProperty('preprocessing');
  });

  it.each([
    { text: '', modelId: 'pinned', elapsedSeconds: 1 },
    { text: '   ', modelId: 'pinned', elapsedSeconds: 1 },
    { text: 'hello', modelId: 'wrong-model', elapsedSeconds: 1 },
    { text: 'hello', modelId: 'pinned', elapsedSeconds: -1 },
  ])('refuses empty, mismatched or malformed model success: %j', async (output) => {
    const job = await create();
    mockModel(async () => Response.json({ ...output, modelId: output.modelId === 'pinned' ? env.MODEL_ID : output.modelId }));
    await queue(job); await queue(job); await queue(job);
    const result = await status(job);
    expect(result.status).toBe('failed');
    expect(result).not.toHaveProperty('text');
    expect((await env.VIDEOS.list()).objects).toHaveLength(0);
  });

  it('reclaims an expired processing lease after interruption', async () => {
    const job = await create();
    await env.DB.prepare("UPDATE jobs SET status = 'processing', lease_id = 'old', lease_until = ?, attempts = 1 WHERE id = ?").bind(Date.now() - 1, job.id).run();
    mockModel();
    await queue(job);
    expect((await status(job)).status).toBe('complete');
  });

  it('preserves the submitted model identity and refuses an incompatible model switch', async () => {
    const job = await create();
    await env.DB.prepare("UPDATE jobs SET model_id = 'historical-model', model_name = 'Historical model' WHERE id = ?").bind(job.id).run();
    const fetch = mockModel();
    await queue(job);
    expect(await status(job)).toMatchObject({ status: 'failed', model: { id: 'historical-model', name: 'Historical model' } });
    expect(fetch).not.toHaveBeenCalled();
    expect((await env.VIDEOS.list()).objects).toHaveLength(0);
  });

  it('fails malformed video input without retaining input or exposing runtime diagnostics', async () => {
    const job = await create();
    mockModel(async () => Response.json({ error: 'ffmpeg private path and exception' }, { status: 422 }));
    const result = await queue(job);
    expect(result.explicitAcks).toHaveLength(1);
    expect(await status(job)).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(await status(job))).not.toContain('private path');
    expect((await env.VIDEOS.list()).objects).toHaveLength(0);
  });

  it('does not cold-start the model while serving public configuration', async () => {
    const fetch = mockModel();
    const response = await call('/api/config');
    expect(await response.json()).toMatchObject({ model: { id: env.MODEL_ID, license: 'CC-BY-SA-4.0' }, limits: { maxBytes: Number(env.MAX_UPLOAD_BYTES), maxDurationSeconds: 30 }, inference: { available: true } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('serves only the blurred public preview while translating the private original', async () => {
    await env.VIDEOS.put('private-examples/original.mp4', 'private original video');
    await env.VIDEOS.put('display-examples/blurred.mp4', 'blurred public video');
    const configuration = await (await call('/api/config')).text();
    expect(configuration).not.toContain('private-examples/original.mp4');
    expect(configuration).not.toContain('display-examples/blurred.mp4');
    expect(new TextDecoder().decode(await (await call('/api/examples/paired-example/video')).arrayBuffer())).toBe('blurred public video');
    const response = await call('/api/jobs', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ exampleId: 'paired-example' }) });
    expect(response.status).toBe(202);
    const job = await response.json<CreatedJob>();
    const fetch = mockModel(async (request) => {
      expect(new TextDecoder().decode(await request.arrayBuffer())).toBe('private original video');
      return success('hello', 0.2, preprocessing({ inputBytes: 'private original video'.length, inferenceBytes: 'private original video'.length }));
    });
    await queue(job);
    expect((await status(job)).text).toBe('hello');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await env.VIDEOS.head('private-examples/original.mp4')).not.toBeNull();
    expect(await env.VIDEOS.head('display-examples/blurred.mp4')).not.toBeNull();
  });

  it('serves full media as 200 when live R2 returns range keys whose values are undefined', async () => {
    await env.VIDEOS.put('display-examples/blurred.mp4', '0123456789');
    const stored = await env.VIDEOS.get('display-examples/blurred.mp4');
    if (!stored) throw new Error('missing test media');
    vi.spyOn(env.VIDEOS, 'get').mockResolvedValueOnce(liveRangeShape(stored, { offset: undefined, length: undefined, suffix: undefined }));
    const response = await call('/api/examples/paired-example/video');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Range')).toBeNull();
    expect(response.headers.get('Content-Length')).toBe('10');
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('0123456789');
  });

  it('serves an offset range as 206 when an undefined suffix key is also present', async () => {
    await env.VIDEOS.put('display-examples/blurred.mp4', '0123456789');
    const stored = await env.VIDEOS.get('display-examples/blurred.mp4', { range: { offset: 2, length: 3 } });
    if (!stored) throw new Error('missing test media');
    vi.spyOn(env.VIDEOS, 'get').mockResolvedValueOnce(liveRangeShape(stored, { offset: 2, length: 3, suffix: undefined }));
    const response = await call('/api/examples/paired-example/video', { headers: { Range: 'bytes=2-4' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 2-4/10');
    expect(response.headers.get('Content-Length')).toBe('3');
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('234');
  });

  it('serves numeric suffix ranges without treating undefined offset keys as numbers', async () => {
    await env.VIDEOS.put('display-examples/blurred.mp4', '0123456789');
    const stored = await env.VIDEOS.get('display-examples/blurred.mp4', { range: { suffix: 3 } });
    if (!stored) throw new Error('missing test media');
    vi.spyOn(env.VIDEOS, 'get').mockResolvedValueOnce(liveRangeShape(stored, { offset: undefined, length: undefined, suffix: 3 }));
    const response = await call('/api/examples/paired-example/video', { headers: { Range: 'bytes=-3' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 7-9/10');
    expect(response.headers.get('Content-Length')).toBe('3');
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('789');
  });

  it('refetches full media before returning 200 if a requested range has unusable R2 metadata', async () => {
    await env.VIDEOS.put('display-examples/blurred.mp4', '0123456789');
    const stored = await env.VIDEOS.get('display-examples/blurred.mp4', { range: { offset: 2, length: 3 } });
    if (!stored) throw new Error('missing test media');
    const get = vi.spyOn(env.VIDEOS, 'get').mockResolvedValueOnce(liveRangeShape(stored, { offset: undefined, length: undefined, suffix: undefined }));
    const response = await call('/api/examples/paired-example/video', { headers: { Range: 'bytes=2-4' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Range')).toBeNull();
    expect(response.headers.get('Content-Length')).toBe('10');
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('0123456789');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('retains body-free 304 responses for conditional media requests', async () => {
    await env.VIDEOS.put('display-examples/blurred.mp4', '0123456789');
    const metadata = await env.VIDEOS.head('display-examples/blurred.mp4');
    if (!metadata) throw new Error('missing test media');
    const response = await call('/api/examples/paired-example/video', { headers: { 'If-None-Match': metadata.httpEtag } });
    expect(response.status).toBe(304);
    expect(response.headers.get('ETag')).toBe(metadata.httpEtag);
    expect(response.headers.get('Content-Range')).toBeNull();
    expect(response.headers.get('Content-Length')).toBeNull();
    expect(await response.text()).toBe('');
  });

  it('fails exhausted transport deliveries visibly and releases private input', async () => {
    const job = await create();
    const fetch = mockModel();
    expect((await queue(job, 'bitsign-web-inference-dead')).explicitAcks).toHaveLength(1);
    expect(await status(job)).toMatchObject({ status: 'failed', stage: 'failed' });
    expect((await env.VIDEOS.list()).objects).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not let a dead-letter delivery interrupt a still-live processing lease', async () => {
    const job = await create();
    await env.DB.prepare("UPDATE jobs SET status = 'processing', lease_id = 'live', lease_until = ? WHERE id = ?").bind(Date.now() + 60_000, job.id).run();
    const result = await queue(job, 'bitsign-web-inference-dead');
    expect(result.retryMessages).toHaveLength(1);
    expect((await status(job)).status).toBe('processing');
    expect((await env.VIDEOS.list()).objects).toHaveLength(1);
  });

  it('fails visibly and releases exhausted interrupted jobs', async () => {
    const job = await create();
    await env.DB.prepare("UPDATE jobs SET status = 'processing', lease_id = 'old', lease_until = ?, attempts = 3 WHERE id = ?").bind(Date.now() - 1, job.id).run();
    const fetch = mockModel();
    await queue(job);
    expect((await status(job)).status).toBe('failed');
    expect(fetch).not.toHaveBeenCalled();
    expect((await env.VIDEOS.list()).objects).toHaveLength(0);
  });

  it('enforces persisted hourly and global active bounds', async () => {
    for (let i = 0; i < 10; i++) await create();
    expect((await call('/api/jobs', videoRequest())).status).toBe(429);
    await create('192.0.2.2'); await create('192.0.2.3');
    expect((await call('/api/jobs', videoRequest('192.0.2.4'))).status).toBe(429);
    expect(await env.DB.prepare('SELECT count(*) AS total FROM jobs').first('total')).toBe(12);
  });

  it('durably accepts an input when Queue.send fails and repairs delivery without another upload', async () => {
    vi.mocked(env.TRANSLATIONS.send).mockRejectedValueOnce(new Error('secret internal failure'));
    const response = await call('/api/jobs', videoRequest());
    expect(response.status).toBe(202);
    const job = await response.json<CreatedJob>();
    expect(await status(job)).toMatchObject({ status: 'queued', stage: 'retrying' });
    expect(JSON.stringify(await status(job))).not.toContain('secret internal failure');
    expect((await env.VIDEOS.list()).objects).toHaveLength(1);
    await env.DB.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').bind(Date.now() - 180_000, job.id).run();
    expect((await reconcileJobs(env)).redriven).toBe(1);
    expect(env.TRANSLATIONS.send).toHaveBeenCalledTimes(2);
    mockModel();
    await queue(job);
    expect((await status(job)).status).toBe('complete');
    expect((await env.VIDEOS.list()).objects).toHaveLength(0);
  });

  it('redrives the crash gap after queued commits but before Queue.send, through the actual cron handler', async () => {
    const job = await create();
    vi.mocked(env.TRANSLATIONS.send).mockClear();
    await env.DB.prepare('UPDATE jobs SET dispatched_at = NULL, updated_at = ? WHERE id = ?').bind(Date.now() - 180_000, job.id).run();
    expect(await status(job)).toMatchObject({ status: 'queued', stage: 'stalled' });
    await worker.scheduled(createScheduledController(), env);
    expect(env.TRANSLATIONS.send).toHaveBeenCalledExactlyOnceWith({ id: job.id });
    expect(await status(job)).toMatchObject({ status: 'queued', stage: 'retrying', model: { id: env.MODEL_ID } });
    expect(await env.DB.prepare('SELECT model_id, attempts, dispatched_at FROM jobs WHERE id = ?').bind(job.id).first()).toMatchObject({ model_id: env.MODEL_ID, attempts: 0, dispatched_at: expect.any(Number) });
    // A legitimate queue wait with a durable dispatch receipt must not create a
    // duplicate message on every scheduled sweep.
    await env.DB.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').bind(Date.now() - 180_000, job.id).run();
    expect((await reconcileJobs(env)).redriven).toBe(0);
    expect(env.TRANSLATIONS.send).toHaveBeenCalledTimes(1);
  });

  it('fails and cleans an abandoned upload whose R2 write committed before the queued transition', async () => {
    const job = await create();
    vi.mocked(env.TRANSLATIONS.send).mockClear();
    await env.DB.prepare("UPDATE jobs SET status = 'uploading', stage = 'uploading', dispatched_at = NULL, lease_id = 'interrupted-upload', lease_until = ?, updated_at = ? WHERE id = ?").bind(Date.now() - 1, Date.now() - 700_000, job.id).run();
    expect((await env.VIDEOS.list()).objects).toHaveLength(1);
    expect((await status(job)).stage).toBe('stalled');
    expect(await reconcileJobs(env)).toMatchObject({ failed: 1, redriven: 0, errors: 0 });
    expect(await status(job)).toMatchObject({ status: 'failed', stage: 'failed', model: { id: env.MODEL_ID } });
    expect((await env.VIDEOS.list()).objects).toHaveLength(0);
    expect(env.TRANSLATIONS.send).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT input_released_at FROM jobs WHERE id = ?').bind(job.id).first('input_released_at')).toEqual(expect.any(Number));
  });

  it('requeues an expired processing lease while preserving the model pin and completed attempt count', async () => {
    const job = await create();
    vi.mocked(env.TRANSLATIONS.send).mockClear();
    await env.DB.prepare("UPDATE jobs SET status = 'processing', stage = 'translating', lease_id = 'lost-process', lease_until = ?, attempts = 1, updated_at = ? WHERE id = ?").bind(Date.now() - 1, Date.now() - 700_000, job.id).run();
    expect((await status(job)).stage).toBe('stalled');
    expect((await reconcileJobs(env)).redriven).toBe(1);
    expect(await env.DB.prepare('SELECT status, lease_id, attempts, model_id FROM jobs WHERE id = ?').bind(job.id).first()).toMatchObject({ status: 'queued', lease_id: null, attempts: 1, model_id: env.MODEL_ID });
    expect((await env.VIDEOS.list()).objects).toHaveLength(1);
    mockModel();
    await queue(job);
    expect(await status(job)).toMatchObject({ status: 'complete', text: 'hello' });
    expect(await env.DB.prepare('SELECT attempts FROM jobs WHERE id = ?').bind(job.id).first('attempts')).toBe(2);
  });

  it('keeps repair pending across another Queue.send failure', async () => {
    const job = await create();
    await env.DB.prepare('UPDATE jobs SET dispatched_at = NULL, updated_at = ? WHERE id = ?').bind(Date.now() - 180_000, job.id).run();
    vi.mocked(env.TRANSLATIONS.send).mockRejectedValueOnce(new Error('delivery temporarily unavailable'));
    expect(await reconcileJobs(env)).toMatchObject({ redriven: 0, errors: 1 });
    expect(await env.DB.prepare('SELECT status, stage, dispatched_at FROM jobs WHERE id = ?').bind(job.id).first()).toMatchObject({ status: 'queued', stage: 'retrying', dispatched_at: null });
    expect((await env.VIDEOS.list()).objects).toHaveLength(1);
    await env.DB.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').bind(Date.now() - 180_000, job.id).run();
    expect(await reconcileJobs(env)).toMatchObject({ redriven: 1, errors: 0 });
  });

  it('preserves live upload and inference leases during reconciliation', async () => {
    const uploading = await create();
    const processing = await create();
    vi.mocked(env.TRANSLATIONS.send).mockClear();
    await env.DB.prepare("UPDATE jobs SET status = 'uploading', lease_id = 'active-upload', lease_until = ?, updated_at = ? WHERE id = ?").bind(Date.now() + 600_000, Date.now() - 700_000, uploading.id).run();
    await env.DB.prepare("UPDATE jobs SET status = 'processing', lease_id = 'active-model', lease_until = ?, updated_at = ? WHERE id = ?").bind(Date.now() + 600_000, Date.now() - 700_000, processing.id).run();
    expect(await reconcileJobs(env)).toMatchObject({ scanned: 0, redriven: 0, failed: 0 });
    expect(env.TRANSLATIONS.send).not.toHaveBeenCalled();
    expect((await env.VIDEOS.list()).objects).toHaveLength(2);
    expect(await env.DB.prepare('SELECT lease_id FROM jobs WHERE id = ?').bind(processing.id).first('lease_id')).toBe('active-model');
  });

  it('fails stale jobs with exhausted attempts or incompatible model pins without dispatching them', async () => {
    const exhausted = await create();
    const incompatible = await create();
    vi.mocked(env.TRANSLATIONS.send).mockClear();
    await env.DB.prepare("UPDATE jobs SET status = 'processing', attempts = 3, lease_id = 'exhausted', lease_until = ?, updated_at = ? WHERE id = ?").bind(Date.now() - 1, Date.now() - 700_000, exhausted.id).run();
    await env.DB.prepare("UPDATE jobs SET model_id = 'historical-model', dispatched_at = NULL, updated_at = ? WHERE id = ?").bind(Date.now() - 180_000, incompatible.id).run();
    expect(await reconcileJobs(env)).toMatchObject({ failed: 2, redriven: 0, errors: 0 });
    expect((await status(exhausted)).status).toBe('failed');
    expect(await status(incompatible)).toMatchObject({ status: 'failed', model: { id: 'historical-model' } });
    expect(env.TRANSLATIONS.send).not.toHaveBeenCalled();
    expect((await env.VIDEOS.list()).objects).toHaveLength(0);
  });

  it('repairs cleanup crash gaps while preserving completed text and deletion tombstones', async () => {
    const completed = await create();
    const deleted = await create();
    const completedKey = await env.DB.prepare('SELECT object_key FROM jobs WHERE id = ?').bind(completed.id).first<string>('object_key');
    const deletedKey = await env.DB.prepare('SELECT object_key FROM jobs WHERE id = ?').bind(deleted.id).first<string>('object_key');
    expect(completedKey).not.toBeNull(); expect(deletedKey).not.toBeNull();
    mockModel();
    await queue(completed);
    await call(`/api/jobs/${deleted.id}`, { method: 'DELETE', headers: { Origin: origin, Authorization: `Bearer ${deleted.token}` } });
    // Recreate the exact durable boundary reached if a process dies after the
    // result/tombstone commit, before it gets to R2 deletion.
    await env.VIDEOS.put(completedKey!, 'completed input still awaiting cleanup');
    await env.VIDEOS.put(deletedKey!, 'deleted input still awaiting cleanup');
    await env.DB.prepare('UPDATE jobs SET input_released_at = NULL WHERE id IN (?, ?)').bind(completed.id, deleted.id).run();
    vi.mocked(env.TRANSLATIONS.send).mockClear();
    expect(await reconcileJobs(env)).toMatchObject({ released: 2, redriven: 0, failed: 0 });
    expect(await status(completed)).toMatchObject({ status: 'complete', text: 'hello', model: { id: env.MODEL_ID } });
    expect(await env.DB.prepare('SELECT status, text FROM jobs WHERE id = ?').bind(deleted.id).first()).toMatchObject({ status: 'deleted', text: null });
    expect((await call(`/api/jobs/${deleted.id}`, { headers: { Authorization: `Bearer ${deleted.token}` } })).status).toBe(404);
    expect(env.TRANSLATIONS.send).not.toHaveBeenCalled();
    expect((await env.VIDEOS.list()).objects).toHaveLength(0);
  });

  it('cannot resurrect a job deleted while reconciliation publishes its replacement message', async () => {
    const job = await create();
    await env.DB.prepare('UPDATE jobs SET dispatched_at = NULL, updated_at = ? WHERE id = ?').bind(Date.now() - 180_000, job.id).run();
    vi.mocked(env.TRANSLATIONS.send).mockImplementationOnce(async () => {
      expect((await call(`/api/jobs/${job.id}`, { method: 'DELETE', headers: { Origin: origin, Authorization: `Bearer ${job.token}` } })).status).toBe(204);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    });
    expect((await reconcileJobs(env)).redriven).toBe(1);
    const fetch = mockModel();
    await queue(job);
    expect(await env.DB.prepare('SELECT status, text FROM jobs WHERE id = ?').bind(job.id).first()).toMatchObject({ status: 'deleted', text: null });
    expect(fetch).not.toHaveBeenCalled();
    expect((await env.VIDEOS.list()).objects).toHaveLength(0);
  });

  it('purges expired private inputs and records while preserving example objects', async () => {
    const job = await create();
    await env.VIDEOS.put('examples/keep.mp4', 'public example');
    await env.DB.prepare('UPDATE jobs SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, job.id).run();
    await purgeExpired(env);
    expect(await env.DB.prepare('SELECT id FROM jobs WHERE id = ?').bind(job.id).first()).toBeNull();
    expect((await env.VIDEOS.list()).objects.map((object) => object.key)).toEqual(['examples/keep.mp4']);
  });
});
