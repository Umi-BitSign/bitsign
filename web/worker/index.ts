import catalogJSON from '../examples/catalog.json';
import { timingSafeEqual } from 'node:crypto';
export { C5Model } from './container';

type QueueJob = { id: string };
type JobStatus = 'uploading' | 'queued' | 'processing' | 'complete' | 'failed' | 'deleted';
interface Example {
  id: string;
  title: string;
  description: string;
  objectKey: string;
  displayObjectKey: string;
  mimeType: string;
  reference?: string;
  attribution: { dataset: string; creator: string; url: string; license: string; licenseUrl: string; changes: string };
}
const catalog: Example[] = catalogJSON;
interface Job {
  id: string;
  token_hash: string;
  status: JobStatus;
  stage: string;
  object_key: string;
  content_type: string;
  example_id: string | null;
  created_at: number;
  expires_at: number;
  started_at: number | null;
  lease_id: string | null;
  lease_until: number | null;
  attempts: number;
  text: string | null;
  error: string | null;
  elapsed_seconds: number | null;
  model_id: string;
  model_name: string;
  updated_at: number;
  input_released_at: number | null;
  dispatched_at: number | null;
  preprocessing_json: string | null;
}

interface PreprocessingReceipt {
  schema: 'bitsign-video-admission/1';
  normalized: boolean;
  inputSha256: string;
  inferenceSha256: string;
  inputBytes: number;
  inferenceBytes: number;
  inputDurationSeconds: number;
  inputWidth?: number;
  inputHeight?: number;
  inputFps?: number;
  inputEstimatedFrames?: number;
  width: number;
  height: number;
  frames: number;
  fps: number;
  durationSeconds: number;
  decodedPixels: number;
  maximumDecodedPixels: number;
  maximumFrames: number;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
// Admission is bounded at 120s and model execution at 600s. Allow transport
// overhead, then keep the processing lease alive beyond that full deadline.
const TRANSPORT_MS = 750_000;
const LEASE_MS = 810_000;
const UPLOAD_STALL_MS = 600_000;
const REDRIVE_STALE_MS = 120_000;
const MAX_ATTEMPTS = 3;
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v']);
const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

class PublicError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: string) { super(message); }
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers: { ...HEADERS, ...headers } });
}

function model(env: Env) {
  return { id: env.MODEL_ID, name: env.MODEL_NAME, cohort: 'C5', license: 'CC-BY-SA-4.0' };
}

function preprocessingReceipt(value: unknown): PreprocessingReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_preprocessing_receipt');
  const record = value as Record<string, unknown>;
  const number = (key: string, maximum: number, integer = false): number => {
    const candidate = record[key];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0 || candidate > maximum || (integer && !Number.isSafeInteger(candidate))) throw new Error('invalid_preprocessing_receipt');
    return candidate;
  };
  if (record.schema !== 'bitsign-video-admission/1' || typeof record.normalized !== 'boolean'
    || typeof record.inputSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.inputSha256)
    || typeof record.inferenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.inferenceSha256)) throw new Error('invalid_preprocessing_receipt');
  const receipt: PreprocessingReceipt = {
    schema: record.schema, normalized: record.normalized,
    inputSha256: record.inputSha256, inferenceSha256: record.inferenceSha256,
    inputBytes: number('inputBytes', 1_073_741_824, true), inferenceBytes: number('inferenceBytes', 1_073_741_824, true),
    inputDurationSeconds: number('inputDurationSeconds', 30.1),
    width: number('width', 7680, true), height: number('height', 7680, true), frames: number('frames', 3600, true), fps: number('fps', 120),
    durationSeconds: number('durationSeconds', 30.1), decodedPixels: number('decodedPixels', 350_000_000, true),
    maximumDecodedPixels: number('maximumDecodedPixels', 350_000_000, true), maximumFrames: number('maximumFrames', 3600, true),
  };
  // Admission v1 initially supplied only input duration/hash/bytes. Preserve
  // those receipts while retaining the richer source geometry when supplied.
  for (const key of ['inputWidth', 'inputHeight', 'inputFps', 'inputEstimatedFrames'] as const) {
    if (key in record) receipt[key] = number(key, key === 'inputFps' ? 240 : key === 'inputEstimatedFrames' ? 10_000 : 7680, key !== 'inputFps');
  }
  if ((!receipt.normalized && (receipt.inputSha256 !== receipt.inferenceSha256 || receipt.inputBytes !== receipt.inferenceBytes))
    || receipt.decodedPixels !== receipt.width * receipt.height * receipt.frames
    || receipt.decodedPixels > receipt.maximumDecodedPixels || receipt.frames > receipt.maximumFrames
    || Math.abs(receipt.durationSeconds - receipt.frames / receipt.fps) > .000001) throw new Error('invalid_preprocessing_receipt');
  return receipt;
}

function sameOrigin(request: Request): void {
  if (request.headers.get('Origin') !== new URL(request.url).origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    throw new PublicError(403, 'Open BitSign directly to submit or delete a video.');
  }
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (!body) throw new PublicError(400, 'The request body is empty.');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new PublicError(413, 'The request is too large.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function parseSmallJSON(body: ReadableStream<Uint8Array> | null, limit: number): Promise<unknown> {
  const bytes = await readBounded(body, limit);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new PublicError(400, 'Send a valid JSON request.'); }
}

async function upload(request: Request, env: Env, key: string, contentType: string, length: number, heartbeat: () => Promise<void>): Promise<void> {
  if (!request.body) throw new PublicError(400, 'Choose a video to upload.');
  // Reject an already oversized first chunk before opening an R2 write. This also
  // avoids forwarding a deliberately false Content-Length to the storage service.
  const reader = request.body.getReader();
  const first = await reader.read();
  if (first.done || first.value.byteLength > length) {
    await reader.cancel();
    reader.releaseLock();
    throw new PublicError(first.done ? 400 : 413, first.done ? 'Choose a video to upload.' : 'The video exceeds the upload limit.');
  }
  const incoming = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(first.value); },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) { reader.releaseLock(); controller.close(); }
      else controller.enqueue(next.value);
    },
    async cancel(reason) { await reader.cancel(reason); reader.releaseLock(); },
  });
  let received = 0;
  const bounded = incoming.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > length || received > Number(env.MAX_UPLOAD_BYTES)) {
        controller.error(new PublicError(413, 'The video exceeds the upload limit.'));
        return;
      }
      await heartbeat();
      controller.enqueue(chunk);
    },
    async flush(controller) {
      if (received !== length || received === 0) controller.error(new PublicError(400, 'The video upload was incomplete.'));
      else await heartbeat();
    },
  }));
  const fixed = new FixedLengthStream(length);
  const abort = new AbortController();
  const transfer = bounded.pipeTo(fixed.writable, { signal: abort.signal });
  const stored = env.VIDEOS.put(key, fixed.readable, { httpMetadata: { contentType } });
  try { await Promise.all([transfer, stored]); }
  catch (error) {
    abort.abort();
    await Promise.allSettled([transfer, stored]);
    throw error;
  }
}

async function findJob(env: Env, id: string): Promise<Job | null> {
  return env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<Job>();
}

async function authorize(request: Request, env: Env, id: string): Promise<Job> {
  const bearer = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  const cookie = request.headers.get('Cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`bitsign_${id}=`))?.split('=')[1];
  const token = bearer ?? cookie;
  const job = await findJob(env, id);
  // Comparing digests with the runtime primitive avoids comparing the capability itself.
  const candidate = await hash(token ?? '');
  if (!job || !token || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(new TextEncoder().encode(candidate), new TextEncoder().encode(job.token_hash)) || job.expires_at <= Date.now()) {
    throw new PublicError(404, 'This translation is unavailable or has expired.');
  }
  return job;
}

async function removePrivateInput(env: Env, job: Pick<Job, 'id' | 'object_key' | 'example_id'>): Promise<void> {
  if (!job.example_id) {
    await env.VIDEOS.delete(job.object_key);
    await env.DB.prepare('UPDATE jobs SET input_released_at = ? WHERE id = ? AND object_key = ? AND example_id IS NULL').bind(Date.now(), job.id, job.object_key).run();
  }
}

async function finishTerminal(message: Message<QueueJob>, env: Env, job: Job): Promise<void> {
  try { await removePrivateInput(env, job); message.ack(); }
  catch {
    console.warn(JSON.stringify({ event: 'input_cleanup_retrying', jobId: job.id }));
    message.retry({ delaySeconds: 60 });
  }
}

async function createJob(request: Request, env: Env): Promise<Response> {
  sameOrigin(request);
  if (env.INFERENCE_ENABLED !== 'true') throw new PublicError(503, 'Translation is temporarily unavailable. Please try again later.');
  const contentType = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() ?? '';
  let example: (typeof catalog)[number] | undefined;
  let length = 0;
  let videoType = contentType;
  if (contentType === 'application/json') {
    const input = await parseSmallJSON(request.body, 1024);
    if (!input || typeof input !== 'object' || !('exampleId' in input) || typeof input.exampleId !== 'string' || Object.keys(input).some((key) => key !== 'exampleId')) {
      throw new PublicError(400, 'Choose one of the available example videos.');
    }
    example = catalog.find((item) => item.id === input.exampleId);
    if (!example) throw new PublicError(404, 'That example video is unavailable.');
    videoType = example.mimeType;
  } else {
    if (!VIDEO_TYPES.has(contentType)) throw new PublicError(415, 'Upload an MP4, WebM or MOV video.');
    const declared = request.headers.get('Content-Length');
    if (!declared || !/^[1-9][0-9]*$/.test(declared)) throw new PublicError(411, 'The video upload must include its size.');
    length = Number(declared);
    if (!Number.isSafeInteger(length) || length > Number(env.MAX_UPLOAD_BYTES)) throw new PublicError(413, 'The video exceeds the upload limit.');
  }
  const id = crypto.randomUUID();
  const token = newToken();
  const key = example?.objectKey ?? `uploads/${id}/${crypto.randomUUID()}`;
  const now = Date.now();
  const uploadLease = crypto.randomUUID();
  const salt = await env.DB.prepare("SELECT value FROM settings WHERE key = 'rate_salt'").first<string>('value');
  if (!salt) throw new Error('rate_salt_missing');
  const ipHash = await hash(`${salt}:${request.headers.get('CF-Connecting-IP') ?? 'local-development'}`);
  // One SQLite statement reserves capacity and a trigger records the rate event atomically.
  const reservation = await env.DB.prepare(`
    INSERT INTO jobs(id, token_hash, ip_hash, status, stage, object_key, content_type, example_id, created_at, updated_at, expires_at, model_id, model_name, lease_id, lease_until)
    SELECT ?, ?, ?, 'uploading', 'uploading', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE (SELECT count(*) FROM jobs WHERE status IN ('uploading','queued','processing') AND expires_at > ?) < 12
      AND (SELECT count(*) FROM rate_events WHERE ip_hash = ? AND created_at > ?) < 10
  `).bind(id, await hash(token), ipHash, key, videoType, example?.id ?? null, now, now, now + DAY, env.MODEL_ID, env.MODEL_NAME, uploadLease, now + UPLOAD_STALL_MS, now, ipHash, now - HOUR).run();
  // D1's change count includes the rate-event trigger as well as the job itself.
  if (reservation.meta.changes < 1) throw new PublicError(429, 'The demo is busy or you have reached the hourly limit. Please try again later.', '60');
  try {
    if (example) {
      if (!await env.VIDEOS.head(key)) throw new PublicError(503, 'This example is temporarily unavailable.');
    } else {
      let lastHeartbeat = now;
      await upload(request, env, key, videoType, length, async () => {
        const at = Date.now();
        if (at - lastHeartbeat < 30_000) return;
        const renewed = await env.DB.prepare("UPDATE jobs SET updated_at = ?, lease_until = ? WHERE id = ? AND status = 'uploading' AND lease_id = ?").bind(at, at + UPLOAD_STALL_MS, id, uploadLease).run();
        if (renewed.meta.changes !== 1) throw new PublicError(409, 'This upload stopped. Please submit the video again.');
        lastHeartbeat = at;
      });
    }
    const promoted = await env.DB.prepare("UPDATE jobs SET status = 'queued', stage = 'queued', lease_id = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'uploading' AND lease_id = ?").bind(Date.now(), id, uploadLease).run();
    if (promoted.meta.changes !== 1) throw new PublicError(409, 'This upload stopped. Please submit the video again.');
  } catch (error) {
    // A database response can be lost after the queued transition committed.
    // Inspect durable state before deciding whether the input is disposable.
    const current = await findJob(env, id);
    if (!current || !['queued', 'processing', 'complete'].includes(current.status)) {
      await env.DB.prepare("UPDATE jobs SET status = 'failed', stage = 'failed', error = 'The video could not be submitted. Please try again.', lease_id = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'uploading' AND lease_id = ?").bind(Date.now(), id, uploadLease).run();
      const failed = await findJob(env, id);
      if (failed && ['failed', 'deleted'].includes(failed.status)) await removePrivateInput(env, failed);
      throw error;
    }
  }
  try {
    await env.TRANSLATIONS.send({ id });
    await env.DB.prepare("UPDATE jobs SET dispatched_at = ? WHERE id = ? AND status = 'queued' AND dispatched_at IS NULL").bind(Date.now(), id).run();
  }
  catch {
    // The queued row is the durable outbox. Scheduled reconciliation republishes
    // it, including when the process dies before this send is ever attempted.
    await env.DB.prepare("UPDATE jobs SET stage = 'retrying', updated_at = ? WHERE id = ? AND status = 'queued'").bind(Date.now(), id).run();
    console.warn(JSON.stringify({ event: 'initial_delivery_retrying', jobId: id }));
  }
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return json({ id, token, status: 'queued' }, 202, { 'Set-Cookie': `bitsign_${id}=${token}; Path=/api/jobs/${id}; HttpOnly; SameSite=Lax; Max-Age=86400${secure}` });
}

async function jobResponse(request: Request, env: Env, id: string): Promise<Response> {
  const job = await authorize(request, env, id);
  if (request.method === 'DELETE') {
    sameOrigin(request);
    // Tombstone first. A queue worker can only commit a result with its still-current lease.
    await env.DB.prepare("UPDATE jobs SET status = 'deleted', stage = 'deleted', text = NULL, error = NULL, preprocessing_json = NULL, lease_id = NULL, lease_until = NULL, deleted_at = ?, updated_at = ? WHERE id = ?").bind(Date.now(), Date.now(), id).run();
    await removePrivateInput(env, job);
    return new Response(null, { status: 204, headers: { ...HEADERS, 'Set-Cookie': `bitsign_${id}=; Path=/api/jobs/${id}; HttpOnly; SameSite=Lax; Max-Age=0` } });
  }
  if (job.status === 'deleted') throw new PublicError(404, 'This translation has been deleted.');
  const elapsed = job.elapsed_seconds ?? Math.max(0, (Date.now() - (job.started_at ?? job.created_at)) / 1000);
  const now = Date.now();
  const stalled = (job.status === 'queued' && job.dispatched_at === null && job.updated_at <= now - REDRIVE_STALE_MS)
    || (job.status === 'processing' && (job.lease_until ?? job.updated_at + LEASE_MS) <= now)
    || (job.status === 'uploading' && (job.lease_until ?? job.updated_at + UPLOAD_STALL_MS) <= now);
  return json({
    id, status: job.status === 'uploading' ? 'queued' : job.status, stage: stalled ? 'stalled' : job.stage,
    ...(job.text !== null ? { text: job.text } : {}), ...(job.error !== null ? { error: job.error } : {}),
    ...(job.preprocessing_json !== null ? { preprocessing: preprocessingReceipt(JSON.parse(job.preprocessing_json)) } : {}),
    elapsedSeconds: elapsed, model: { ...model(env), id: job.model_id, name: job.model_name },
    progress: { elapsedSeconds: elapsed, etaSeconds: null, etaBasis: 'Inference timing is being measured; no reliable estimate is available yet.' },
  });
}

async function exampleVideo(request: Request, env: Env, id: string): Promise<Response> {
  const example = catalog.find((item) => item.id === id);
  if (!example) throw new PublicError(404, 'That example video is unavailable.');
  // Only the privacy-blurred display asset is public. Inference reads objectKey
  // separately, and neither storage key is included in the public configuration.
  if (!example.displayObjectKey) throw new PublicError(503, 'That example video is temporarily unavailable.');
  const requestedRange = request.headers.get('Range')?.match(/^bytes=(\d*)-(\d*)$/);
  const hasRange = Boolean(requestedRange && (requestedRange[1] || requestedRange[2])
    && (!requestedRange[1] || Number.isSafeInteger(Number(requestedRange[1])))
    && (!requestedRange[2] || Number.isSafeInteger(Number(requestedRange[2])))
    && (requestedRange[1] ? !requestedRange[2] || Number(requestedRange[2]) >= Number(requestedRange[1]) : Number(requestedRange[2]) > 0));
  let object = await env.VIDEOS.get(example.displayObjectKey, { ...(hasRange ? { range: request.headers } : {}), onlyIf: request.headers });
  if (!object) throw new PublicError(404, 'That example video is unavailable.');
  const headers = new Headers({ ...HEADERS, 'Cache-Control': 'public, max-age=3600', 'Accept-Ranges': 'bytes', 'Content-Type': example.mimeType, ETag: object.httpEtag });
  if (!('body' in object)) return new Response(null, { status: 304, headers });
  if (hasRange && object.range) {
    // Live R2 can return a range object with optional properties present but
    // undefined. Property presence alone does not identify a suffix response.
    const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
    const suffix = 'suffix' in object.range ? object.range.suffix : undefined;
    const start = 'offset' in object.range ? object.range.offset : undefined;
    const size = 'length' in object.range ? object.range.length : undefined;
    const offset = numeric(start) && start >= 0 ? start : numeric(suffix) && suffix > 0 ? Math.max(0, object.size - suffix) : undefined;
    const length = numeric(size) && size > 0 ? size : numeric(suffix) && suffix > 0 && offset !== undefined ? object.size - offset : undefined;
    if (offset !== undefined && length !== undefined && offset < object.size && length <= object.size - offset) {
      headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
      headers.set('Content-Length', String(length));
      return new Response(object.body, { status: 206, headers });
    }
  }
  if (hasRange) {
    // If range metadata is unusable, its body might still be partial. Fetch the
    // full object before advertising a full 200 response and content length.
    await object.body.cancel();
    object = await env.VIDEOS.get(example.displayObjectKey, { onlyIf: request.headers });
    if (!object) throw new PublicError(404, 'That example video is unavailable.');
    headers.set('ETag', object.httpEtag);
    if (!('body' in object)) return new Response(null, { status: 304, headers });
  }
  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
}

async function translate(env: Env, job: Job): Promise<{ text: string; elapsedSeconds: number; preprocessing: PreprocessingReceipt }> {
  if (job.model_id !== env.MODEL_ID) throw new PublicError(503, 'The model selected for this translation is unavailable. Please submit a new video.');
  const input = await env.VIDEOS.get(job.object_key);
  if (!input) throw new PublicError(422, 'The video is no longer available. Please upload it again.');
  let response: Response;
  try {
    response = await env.MODEL.getByName('c5').fetch(new Request('http://model/translate', {
      method: 'POST', body: input.body, headers: { 'Content-Type': job.content_type, 'Content-Length': String(input.size) }, signal: AbortSignal.timeout(TRANSPORT_MS),
    }));
  } catch (error) {
    // Transport failures contain platform diagnostics, never model stdout or
    // request headers. Bound and redact them so deployment faults are visible.
    const detail = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[url]').replace(/[a-f0-9]{64}/gi, '[digest]').slice(0, 400) : 'unknown_transport_failure';
    console.warn(JSON.stringify({ event: 'model_transport_failed', detail }));
    throw error;
  }
  if (!response.ok) {
    let detail = 'unavailable';
    try {
      const bytes = await readBounded(response.body, 1024);
      detail = new TextDecoder().decode(bytes).replace(/https?:\/\/\S+/g, '[url]').replace(/[a-f0-9]{64}/gi, '[digest]').slice(0, 400);
    } catch { /* Oversized diagnostics are discarded, never forwarded to users. */ }
    console.warn(JSON.stringify({ event: 'model_http_failed', status: response.status, detail }));
    if (response.status === 400 || response.status === 413 || response.status === 415 || response.status === 422) {
      throw new PublicError(422, 'The model could not read this video. Try a clear, shorter video in a supported format.');
    }
    throw new Error(`inference_status_${response.status}`);
  }
  let result: unknown;
  try { result = await parseSmallJSON(response.body, 65_536); }
  catch { throw new Error('invalid_inference_json'); }
  if (!result || typeof result !== 'object' || !('text' in result) || !('modelId' in result) || !('elapsedSeconds' in result) || result.modelId !== env.MODEL_ID || typeof result.text !== 'string' || result.text.trim().length === 0 || result.text.length > 8192 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(result.text) || typeof result.elapsedSeconds !== 'number' || !Number.isFinite(result.elapsedSeconds) || result.elapsedSeconds < 0 || result.elapsedSeconds > 900) {
    throw new Error('invalid_inference_result');
  }
  if (!('preprocessing' in result)) throw new Error('missing_preprocessing_receipt');
  const preprocessing = preprocessingReceipt(result.preprocessing);
  if (preprocessing.inputBytes !== input.size || preprocessing.inferenceBytes > Number(env.MAX_UPLOAD_BYTES)) throw new Error('preprocessing_input_mismatch');
  return { text: result.text, elapsedSeconds: result.elapsedSeconds, preprocessing };
}

/** Queue processing persists leases and checks them again when committing a result. */
export async function processJob(message: Message<QueueJob>, env: Env): Promise<void> {
  const id = message.body?.id;
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) { message.ack(); return; }
  const now = Date.now();
  let job = await findJob(env, id);
  if (!job) { message.ack(); return; }
  if (['complete', 'failed', 'deleted'].includes(job.status)) { await finishTerminal(message, env, job); return; }
  if (job.expires_at <= now) {
    await env.DB.prepare("UPDATE jobs SET status = 'failed', stage = 'expired', error = 'This translation expired. Please submit it again.', updated_at = ? WHERE id = ? AND status NOT IN ('complete','failed','deleted')").bind(now, id).run();
    await removePrivateInput(env, job); message.ack(); return;
  }
  if (job.attempts >= MAX_ATTEMPTS && (job.status === 'queued' || (job.status === 'processing' && (job.lease_until ?? 0) < now))) {
    await env.DB.prepare("UPDATE jobs SET status = 'failed', stage = 'failed', error = 'Translation is temporarily unavailable. Please try again.', lease_id = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status IN ('queued','processing') AND (lease_until IS NULL OR lease_until < ?)").bind(now, id, now).run();
    await removePrivateInput(env, job); message.ack(); return;
  }
  const lease = crypto.randomUUID();
  const claimed = await env.DB.prepare(`UPDATE jobs SET status = 'processing', stage = 'translating', lease_id = ?, lease_until = ?, started_at = COALESCE(started_at, ?), updated_at = ?, attempts = attempts + 1
    WHERE id = ? AND (status = 'queued' OR (status = 'processing' AND lease_until < ?)) AND attempts < ?`).bind(lease, now + LEASE_MS, now, now, id, now, MAX_ATTEMPTS).run();
  if (claimed.meta.changes !== 1) {
    job = await findJob(env, id);
    if (job?.status === 'processing' || job?.status === 'uploading') message.retry({ delaySeconds: 60 });
    else message.ack();
    return;
  }
  job = await findJob(env, id);
  if (!job) { message.ack(); return; }
  try {
    const result = await translate(env, job);
    const completed = await env.DB.prepare("UPDATE jobs SET status = 'complete', stage = 'complete', text = ?, elapsed_seconds = ?, preprocessing_json = ?, error = NULL, lease_id = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'processing' AND lease_id = ? AND expires_at > ?").bind(result.text, result.elapsedSeconds, JSON.stringify(result.preprocessing), Date.now(), id, lease, Date.now()).run();
    if (completed.meta.changes === 1 || (await findJob(env, id))?.status === 'deleted') await finishTerminal(message, env, job);
    else message.ack();
  } catch (error) {
    const permanent = error instanceof PublicError || job.attempts >= MAX_ATTEMPTS;
    const status = permanent ? 'failed' : 'queued';
    const errorText = error instanceof PublicError ? error.message : 'Translation is temporarily unavailable. Please try again.';
    const updated = await env.DB.prepare('UPDATE jobs SET status = ?, stage = ?, error = ?, lease_id = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status = \'processing\' AND lease_id = ?').bind(status, permanent ? 'failed' : 'retrying', permanent ? errorText : null, Date.now(), id, lease).run();
    console.warn(JSON.stringify({ event: 'translation_attempt_failed', jobId: id, attempt: job.attempts, terminal: permanent }));
    if (updated.meta.changes === 0 || permanent) {
      if (updated.meta.changes === 1 || (await findJob(env, id))?.status === 'deleted') await finishTerminal(message, env, job);
      else message.ack();
    } else message.retry({ delaySeconds: 60 });
  }
}

/** Repairs crash gaps using bounded work; completed results and tombstones survive. */
export async function reconcileJobs(env: Env): Promise<{ scanned: number; redriven: number; failed: number; released: number; errors: number; elapsedSeconds: number }> {
  const started = Date.now();
  const counts = { scanned: 0, redriven: 0, failed: 0, released: 0, errors: 0, elapsedSeconds: 0 };
  const stale = await env.DB.prepare(`SELECT * FROM jobs WHERE expires_at > ? AND (
    (status = 'uploading' AND COALESCE(lease_until, updated_at + ?) <= ?)
    OR (status = 'queued' AND dispatched_at IS NULL AND updated_at <= ?)
    OR (status = 'processing' AND COALESCE(lease_until, updated_at + ?) <= ?)
  ) ORDER BY updated_at LIMIT 100`).bind(started, UPLOAD_STALL_MS, started, started - REDRIVE_STALE_MS, LEASE_MS, started).all<Job>();
  for (const job of stale.results) {
    counts.scanned++;
    try {
      const at = Date.now();
      if (job.status === 'uploading' || job.attempts >= MAX_ATTEMPTS || job.model_id !== env.MODEL_ID) {
        const reason = job.status === 'uploading' ? 'The upload stopped before submission finished. Please submit the video again.'
          : job.model_id !== env.MODEL_ID ? 'The model selected for this translation is unavailable. Please submit a new video.'
            : 'Translation could not finish after several retries. Please submit it again.';
        const failed = await env.DB.prepare(`UPDATE jobs SET status = 'failed', stage = 'failed', error = ?, lease_id = NULL, lease_until = NULL, updated_at = ?
          WHERE id = ? AND status = ? AND updated_at = ? AND COALESCE(lease_id, '') = ?`).bind(reason, at, job.id, job.status, job.updated_at, job.lease_id ?? '').run();
        if (failed.meta.changes === 1) { counts.failed++; await removePrivateInput(env, job); counts.released++; }
        continue;
      }
      // Claim the repair with a compare-and-set before publishing. A concurrent
      // heartbeat, processing claim, completion or deletion makes this a no-op.
      const claimed = await env.DB.prepare(`UPDATE jobs SET status = 'queued', stage = 'retrying', lease_id = NULL, lease_until = NULL, dispatched_at = NULL, updated_at = ?
        WHERE id = ? AND status = ? AND updated_at = ? AND COALESCE(lease_id, '') = ?`).bind(at, job.id, job.status, job.updated_at, job.lease_id ?? '').run();
      if (claimed.meta.changes !== 1) continue;
      await env.TRANSLATIONS.send({ id: job.id });
      await env.DB.prepare("UPDATE jobs SET dispatched_at = ? WHERE id = ? AND status = 'queued' AND updated_at = ?").bind(Date.now(), job.id, at).run();
      counts.redriven++;
    } catch {
      counts.errors++;
      console.warn(JSON.stringify({ event: 'job_reconciliation_retrying', jobId: job.id }));
    }
  }
  // A process can die after its result/tombstone commits and before R2 cleanup.
  // Persisted release receipts let this repair run without repeating inference.
  const pending = await env.DB.prepare("SELECT * FROM jobs WHERE status IN ('complete','failed','deleted') AND example_id IS NULL AND input_released_at IS NULL ORDER BY updated_at LIMIT 100").all<Job>();
  for (const job of pending.results) {
    counts.scanned++;
    try { await removePrivateInput(env, job); counts.released++; }
    catch { counts.errors++; console.warn(JSON.stringify({ event: 'input_cleanup_retrying', jobId: job.id })); }
  }
  counts.elapsedSeconds = (Date.now() - started) / 1000;
  console.info(JSON.stringify({ event: 'job_reconciliation_complete', ...counts }));
  return counts;
}

export async function purgeExpired(env: Env): Promise<void> {
  const now = Date.now();
  const expired = await env.DB.prepare('SELECT * FROM jobs WHERE expires_at <= ? ORDER BY expires_at LIMIT 100').bind(now).all<Job>();
  for (const job of expired.results) {
    // Tombstone before deleting storage, so an in-flight consumer cannot recreate results.
    await env.DB.prepare("UPDATE jobs SET status = 'deleted', text = NULL, error = NULL, preprocessing_json = NULL, lease_id = NULL, lease_until = NULL, deleted_at = ?, updated_at = ? WHERE id = ?").bind(now, now, job.id).run();
    await removePrivateInput(env, job);
    await env.DB.prepare("DELETE FROM jobs WHERE id = ? AND status = 'deleted'").bind(job.id).run();
  }
  await env.DB.prepare('DELETE FROM rate_events WHERE created_at <= ?').bind(now - HOUR).run();
}

/** Delivery failures must end visibly, even if they happened before model inference. */
export async function processDeadLetter(message: Message<QueueJob>, env: Env): Promise<void> {
  const id = message.body?.id;
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) { message.ack(); return; }
  let job = await findJob(env, id);
  if (!job) { message.ack(); return; }
  if (['complete', 'failed', 'deleted'].includes(job.status)) { await finishTerminal(message, env, job); return; }
  const now = Date.now();
  if (job.status === 'processing' && (job.lease_until ?? 0) > now) {
    message.retry({ delaySeconds: Math.ceil(((job.lease_until ?? now) - now) / 1000) + 1 });
    return;
  }
  const failed = await env.DB.prepare("UPDATE jobs SET status = 'failed', stage = 'failed', error = 'Translation could not finish after several retries. Please submit it again.', lease_id = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status IN ('uploading','queued','processing') AND (lease_until IS NULL OR lease_until <= ?)").bind(now, id, now).run();
  if (failed.meta.changes === 1) {
    console.warn(JSON.stringify({ event: 'translation_delivery_exhausted', jobId: id }));
    await finishTerminal(message, env, job);
  } else {
    job = await findJob(env, id);
    if (!job) message.ack();
    else if (['complete', 'failed', 'deleted'].includes(job.status)) await finishTerminal(message, env, job);
    else message.retry({ delaySeconds: 60 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (url.pathname === '/api/config' && request.method === 'GET') return json({
        model: model(env), limits: { maxBytes: Number(env.MAX_UPLOAD_BYTES), maxDurationSeconds: Number(env.MAX_DURATION_SECONDS) },
        examples: catalog.map(({ id, title, description, reference, attribution }) => ({ id, title, description, reference, attribution, videoUrl: `/api/examples/${id}/video` })),
        inference: { available: env.INFERENCE_ENABLED === 'true' && Boolean(env.MODEL_ID && env.MODEL) },
      });
      if (url.pathname === '/api/jobs' && request.method === 'POST') return await createJob(request, env);
      const jobPath = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})$/);
      if (jobPath && (request.method === 'GET' || request.method === 'DELETE')) return await jobResponse(request, env, jobPath[1]);
      const examplePath = url.pathname.match(/^\/api\/examples\/([a-z0-9-]+)\/video$/);
      if (examplePath && request.method === 'GET') return await exampleVideo(request, env, examplePath[1]);
      return json({ error: 'This endpoint is unavailable.' }, 404);
    } catch (error) {
      if (error instanceof PublicError) return json({ error: error.message }, error.status, error.retryAfter ? { 'Retry-After': error.retryAfter } : undefined);
      console.error(JSON.stringify({ event: 'api_request_failed', path: url.pathname.replace(/[0-9a-f-]{36}/g, ':id'), method: request.method }));
      return json({ error: 'The demo is temporarily unavailable. Please try again.' }, 503);
    }
  },
  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      if (batch.queue === 'bitsign-web-inference-dead') await processDeadLetter(message, env);
      else await processJob(message, env);
    }
  },
  async scheduled(_controller, env): Promise<void> { await reconcileJobs(env); await purgeExpired(env); },
} satisfies ExportedHandler<Env, QueueJob>;
