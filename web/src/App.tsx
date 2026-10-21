import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, ReactNode } from 'react';

type Attribution = { dataset: string; creator: string; url: string; license: string; licenseUrl: string; changes: string };

type Example = {
  id: string;
  title: string;
  description: string;
  videoUrl: string;
  reference?: string;
  attribution: Attribution | string;
};

type Config = {
  model: { name: string; cohort: string; id: string; license: string };
  limits: { maxBytes: number; maxDurationSeconds: number };
  examples: Example[];
  inference: { available: boolean };
};

type JobStatus = 'queued' | 'processing' | 'complete' | 'failed';
type Job = {
  id: string;
  token: string;
  status: JobStatus;
  startedAt: number;
  label: string;
  exampleId?: string;
  stage?: string;
  text?: string;
  error?: string;
  elapsedSeconds?: number;
  model?: { id: string; name: string };
  videoUrl?: string;
  pollingFailed?: boolean;
  preprocessing?: { normalized: boolean };
};

type VideoSource =
  | { kind: 'example'; url: string; label: string; example: Example }
  | { kind: 'upload' | 'recording'; url: string; label: string; file: File; duration: number }
  | { kind: 'restored'; url?: string; label: string };

type Mode = 'examples' | 'upload' | 'record';
type IconName = 'arrow' | 'upload' | 'camera' | 'play' | 'close' | 'check' | 'clock' | 'trash' | 'refresh' | 'pause' | 'file' | 'chevron';

const SESSION_KEY = 'bitsign.current-job.v1';

function Icon({ name, size = 20, className = '' }: { name: IconName; size?: number; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
    upload: <><path d="M12 16V4m-4 4 4-4 4 4M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" /></>,
    camera: <><rect x="3" y="6" width="12" height="13" rx="3" /><path d="m15 10 6-3v12l-6-3" /></>,
    play: <path d="m9 5 11 7-11 7V5Z" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" /></>,
    pause: <><path d="M8 5v14M16 5v14" /></>,
    file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6m-12 5h8m-8 3h5" /></>,
    chevron: <path d="m9 5 7 7-7 7" />,
  };
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Brand({ light = false }: { light?: boolean }) {
  return <a className={`brand ${light ? 'brand-light' : ''}`} href="#" aria-label="bitsign home">
    <span className="brand-mark" aria-hidden="true"><img src="/umi-mark.png" alt="" width="1536" height="1024" /></span>
    <span className="brand-label">/bitsign</span>
  </a>;
}

function HandsIllustration() {
  return <svg className="hands-illustration" viewBox="0 0 250 180" fill="none" aria-hidden="true">
    <circle cx="125" cy="87" r="67" stroke="currentColor" strokeDasharray="2 9" opacity=".22" />
    <circle cx="125" cy="87" r="46" fill="currentColor" opacity=".035" />
    <g stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="m83 140-19-28c-5-8-12-14-13-21-1-6 5-9 9-4l13 14-12-41c-2-7 6-11 9-4l13 30-7-44c-1-7 8-9 10-2l9 43-1-36c0-7 8-8 10-1l5 43 7-24c2-7 11-4 9 3l-9 39c-2 11-12 21-8 33" />
      <path d="m166 143 18-28c5-8 12-14 13-21 1-6-5-9-9-4l-13 14 12-41c2-7-6-11-9-4l-13 30 7-44c1-7-8-9-10-2l-9 43 1-36c0-7-8-8-10-1l-5 43-7-24c-2-7-11-4-9 3l9 39c2 11 12 21 8 33" />
      <path d="m109 18 3 8m14-13v9m14-5-3 8" opacity=".55" />
    </g>
    <path d="M66 149h116" stroke="currentColor" strokeWidth="1.5" opacity=".2" />
  </svg>;
}

function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function formatBytes(bytes: number) {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function attributionLabel(attribution: Attribution | string) {
  return typeof attribution === 'string' ? attribution : `${attribution.dataset} · ${attribution.creator} · ${attribution.license}`;
}

function videoPreviewUrl(url: string) {
  // A tiny time fragment asks Safari to decode a preview frame before playback.
  return url.includes('#') ? url : `${url}#t=0.001`;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function responseError(response: Response) {
  try {
    const body = await response.json() as { error?: string; message?: string };
    return body.error || body.message || `The request failed (${response.status}). Please try again.`;
  } catch {
    return `The request failed (${response.status}). Please try again.`;
  }
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = window.setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function inspectVideo(file: File) {
  return new Promise<number>((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      video.onloadedmetadata = null;
      video.onerror = null;
      const duration = video.duration;
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve(duration);
    };
    const timeout = window.setTimeout(() => finish(new Error('This video could not be previewed. Try an MP4 or WebM file.')), 12_000);
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        finish(new Error('We could not read this video’s length. Try exporting it as MP4.'));
      } else finish();
    };
    video.onerror = () => finish(new Error('Your browser could not read this video. Try an MP4 or WebM file.'));
    video.src = url;
  });
}

function sourceMime(file: File) {
  const declaredType = file.type.toLowerCase().split(';', 1)[0].trim();
  const allowedTypes = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v'];
  if (allowedTypes.includes(declaredType)) return declaredType === 'video/x-m4v' ? 'video/mp4' : file.type;
  if (declaredType && declaredType !== 'application/octet-stream') return undefined;
  const extension = file.name.split('.').pop()?.toLowerCase();
  const knownTypes: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
  return extension ? knownTypes[extension] : undefined;
}

function saveJob(job: Job | null) {
  try {
    if (job) {
      const { id, token, startedAt, label, exampleId } = job;
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id, token, startedAt, label, exampleId }));
    } else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* Private browsing can disable session storage. The current page still works. */ }
}

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState('');
  const [configRevision, setConfigRevision] = useState(0);
  const [mode, setMode] = useState<Mode>('examples');
  const [source, setSource] = useState<VideoSource | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [inputError, setInputError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [pollRevision, setPollRevision] = useState(0);
  const [networkNote, setNetworkNote] = useState('');
  const [cameraState, setCameraState] = useState<'off' | 'requesting' | 'ready' | 'recording'>('off');
  const [cameraError, setCameraError] = useState('');
  const [recordedSeconds, setRecordedSeconds] = useState(0);
  const [copied, setCopied] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraVideo = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const discardRecording = useRef(false);
  const recordingStarted = useRef(0);
  const recordingTimer = useRef<number | null>(null);
  const cameraVersion = useRef(0);
  const selectionVersion = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const uploadStarted = useRef(0);
  const pollController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const resultHeading = useRef<HTMLHeadingElement>(null);

  const processing = Boolean(job && (job.status === 'queued' || job.status === 'processing'));
  const busy = isUploading || processing;
  const locked = busy || isDeleting || isValidating || cameraState === 'recording';
  const modelReady = Boolean(config?.inference.available);
  const activeExample = source?.kind === 'example' ? source.example : undefined;
  const previewUrl = source?.url || job?.videoUrl;

  useEffect(() => {
    mounted.current = true;
    try {
      const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null') as Partial<Job> | null;
      if (saved && typeof saved.id === 'string' && typeof saved.token === 'string' && typeof saved.startedAt === 'number') {
        setJob({ ...saved, id: saved.id, token: saved.token, startedAt: saved.startedAt, label: saved.label || 'Your video', status: 'queued' });
        setSource({ kind: 'restored', label: saved.label || 'Your video' });
      }
    } catch { saveJob(null); }
    return () => {
      mounted.current = false;
      cameraVersion.current += 1;
      selectionVersion.current += 1;
      discardRecording.current = true;
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      streamRef.current?.getTracks().forEach(track => track.stop());
      if (recordingTimer.current !== null) window.clearInterval(recordingTimer.current);
      requestController.current?.abort();
      pollController.current?.abort();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setConfigError('');
    void fetch('/api/config', { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(await responseError(response));
        return response.json() as Promise<Config>;
      })
      .then(data => setConfig(data))
      .catch(error => { if (!isAbort(error)) setConfigError(errorMessage(error, 'The demo could not connect. Please try again.')); });
    return () => controller.abort();
  }, [configRevision]);

  useEffect(() => {
    if (source?.kind !== 'upload' && source?.kind !== 'recording') return;
    return () => URL.revokeObjectURL(source.url);
  }, [source]);

  useEffect(() => {
    if (config && job?.exampleId && source?.kind === 'restored') {
      const example = config.examples.find(item => item.id === job.exampleId);
      if (example) setSource({ kind: 'example', url: videoPreviewUrl(example.videoUrl), label: example.title, example });
    }
  }, [config, job?.exampleId, source?.kind]);

  useEffect(() => {
    if (!job?.id || !job.token) return;
    const { id, token } = job;
    const controller = new AbortController();
    pollController.current = controller;
    let failures = 0;
    async function poll() {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
          if (!response.ok) {
            const message = await responseError(response);
            if (response.status === 404 || response.status === 410 || response.status === 401) {
              setJob(current => current?.id === id ? { ...current, status: 'failed', error: message, pollingFailed: false } : current);
              saveJob(null);
              return;
            }
            throw new Error(message);
          }
          const next = await response.json() as Omit<Job, 'token' | 'startedAt' | 'label'>;
          if (controller.signal.aborted) return;
          failures = 0;
          setNetworkNote('');
          setJob(current => current?.id === id ? { ...current, ...next, id, token, pollingFailed: false } : current);
          if (next.status === 'complete' || next.status === 'failed') return;
          await wait(1_800, controller.signal);
        } catch (error) {
          if (isAbort(error) || controller.signal.aborted) return;
          failures += 1;
          if (failures >= 4) {
            setNetworkNote('');
            setJob(current => current?.id === id ? { ...current, status: 'failed', pollingFailed: true, error: 'We lost the connection while checking your translation. Your job may still be running.' } : current);
            return;
          }
          setNetworkNote('Connection interrupted. Reconnecting…');
          try { await wait(Math.min(2_000 * 2 ** (failures - 1), 8_000), controller.signal); } catch { return; }
        }
      }
    }
    void poll();
    return () => controller.abort();
  }, [job?.id, job?.token, pollRevision]);

  useEffect(() => {
    if (!busy) return;
    const update = () => setElapsed(Math.max(0, (Date.now() - (job?.startedAt || uploadStarted.current || Date.now())) / 1000));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [busy, job?.startedAt]);

  useEffect(() => {
    if (cameraVideo.current && streamRef.current) cameraVideo.current.srcObject = streamRef.current;
  }, [cameraState]);

  useEffect(() => {
    if (job?.status === 'complete') resultHeading.current?.focus({ preventScroll: true });
  }, [job?.status]);

  function stopCamera(discard = true) {
    cameraVersion.current += 1;
    discardRecording.current = discard;
    if (recordingTimer.current !== null) {
      window.clearInterval(recordingTimer.current);
      recordingTimer.current = null;
    }
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    setCameraState('off');
  }

  async function removeJob() {
    requestController.current?.abort();
    pollController.current?.abort();
    setIsUploading(false);
    setNetworkNote('');
    if (!job) return true;
    setIsDeleting(true);
    setInputError('');
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${job.token}` } });
      if (!response.ok && response.status !== 404 && response.status !== 410) throw new Error(await responseError(response));
      if (!mounted.current) return false;
      setJob(null);
      saveJob(null);
      setElapsed(0);
      return true;
    } catch (error) {
      if (mounted.current) setInputError(errorMessage(error, 'Deletion could not be confirmed. Please try again.'));
      return false;
    } finally {
      if (mounted.current) setIsDeleting(false);
    }
  }

  async function chooseExample(example: Example) {
    if (locked) return;
    if (job && !(await removeJob())) return;
    stopCamera();
    setInputError('');
    setSource({ kind: 'example', url: videoPreviewUrl(example.videoUrl), label: example.title, example });
    setMode('examples');
  }

  async function chooseFile(file: File, kind: 'upload' | 'recording' = 'upload', knownDuration?: number) {
    if (!config) return;
    const version = ++selectionVersion.current;
    setInputError('');
    if (!sourceMime(file)) { setInputError('Choose an MP4, WebM, MOV, or M4V video.'); return; }
    if (file.size === 0) { setInputError('This video is empty. Please choose another file.'); return; }
    if (file.size > config.limits.maxBytes) { setInputError(`This video is too large. Choose one under ${formatBytes(config.limits.maxBytes)}.`); return; }
    setIsValidating(true);
    try {
      const duration = knownDuration ?? await inspectVideo(file);
      if (version !== selectionVersion.current || !mounted.current) return;
      if (duration > config.limits.maxDurationSeconds + 0.25) throw new Error(`Choose a clip up to ${config.limits.maxDurationSeconds} seconds long.`);
      if (job && !(await removeJob())) return;
      if (version !== selectionVersion.current || !mounted.current) return;
      stopCamera();
      setSource({ kind, url: URL.createObjectURL(file), label: kind === 'recording' ? 'Your camera recording' : file.name, file, duration });
      setMode(kind === 'recording' ? 'record' : 'upload');
    } catch (error) {
      if (version === selectionVersion.current && mounted.current) setInputError(errorMessage(error, 'This video could not be opened. Please try another file.'));
    } finally {
      if (version === selectionVersion.current && mounted.current) setIsValidating(false);
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void chooseFile(file);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    if (locked) return;
    const files = event.dataTransfer.files;
    if (files.length > 1) { setInputError('Choose one video at a time.'); return; }
    if (files[0]) void chooseFile(files[0]);
  }

  async function changeMode(next: Mode) {
    if (locked || next === mode) return;
    if (job && !(await removeJob())) return;
    if (cameraState !== 'off') stopCamera();
    setSource(null);
    setCameraError('');
    setInputError('');
    setMode(next);
  }

  async function enableCamera() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setCameraError('Recording is not supported in this browser. You can upload a video instead.');
      return;
    }
    if (job && !(await removeJob())) return;
    setCameraError('');
    setInputError('');
    setCameraState('requesting');
    const version = ++cameraVersion.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } });
      if (version !== cameraVersion.current || !mounted.current) { stream.getTracks().forEach(track => track.stop()); return; }
      streamRef.current = stream;
      setSource(null);
      setRecordedSeconds(0);
      setCameraState('ready');
    } catch (error) {
      if (version !== cameraVersion.current || !mounted.current) return;
      let name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
      if (name !== 'NotAllowedError' && navigator.permissions?.query) {
        try {
          const permission = await navigator.permissions.query({ name: 'camera' as PermissionName });
          if (permission.state === 'denied') name = 'NotAllowedError';
        } catch { /* Some browsers do not expose camera permission queries. */ }
      }
      if (version !== cameraVersion.current || !mounted.current) return;
      setCameraState('off');
      setCameraError(name === 'NotAllowedError'
        ? 'Camera access was denied. Allow it in your browser’s site settings, or upload a video.'
        : name === 'NotFoundError'
          ? 'No camera was found. Connect a camera or upload a video.'
          : name === 'NotReadableError'
            ? 'Your camera is busy. Close other apps using it and try again.'
            : name === 'NotSupportedError'
              ? 'Camera recording is unavailable in this browser. You can upload a video instead.'
            : 'The camera could not start. Please try again or upload a video.');
    }
  }

  function startRecording() {
    const stream = streamRef.current;
    if (!stream || !config) return;
    try {
      const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      let bytes = 0;
      discardRecording.current = false;
      recorderRef.current = recorder;
      recorder.ondataavailable = event => {
        if (event.data.size > 0) { chunks.push(event.data); bytes += event.data.size; }
        if (bytes > config.limits.maxBytes && recorder.state === 'recording') stopCamera(false);
      };
      recorder.onerror = () => {
        stopCamera();
        setCameraError('The recording was interrupted. Please try again or upload a video.');
      };
      recorder.onstop = () => {
        const duration = (Date.now() - recordingStarted.current) / 1000;
        if (discardRecording.current || !mounted.current) return;
        const type = recorder.mimeType || chunks[0]?.type || 'video/webm';
        const file = new File(chunks, `bitsign-recording.${type.includes('mp4') ? 'mp4' : 'webm'}`, { type });
        void chooseFile(file, 'recording', duration);
      };
      recordingStarted.current = Date.now();
      recorder.start(250);
      setCameraState('recording');
      setRecordedSeconds(0);
      recordingTimer.current = window.setInterval(() => {
        const seconds = (Date.now() - recordingStarted.current) / 1000;
        setRecordedSeconds(seconds);
        if (seconds >= config.limits.maxDurationSeconds) stopCamera(false);
      }, 200);
    } catch {
      stopCamera();
      setCameraError('This browser could not record the video. Try uploading an MP4 or WebM file.');
    }
  }

  async function translate() {
    if (!source || !config || !modelReady || busy || isDeleting) return;
    if (source.kind === 'restored') return;
    if (job && !(await removeJob())) return;
    stopCamera();
    setInputError('');
    uploadStarted.current = Date.now();
    setIsUploading(true);
    setElapsed(0);
    setNetworkNote('');
    const controller = new AbortController();
    requestController.current = controller;
    const startedAt = uploadStarted.current;
    try {
      const isExample = source.kind === 'example';
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: isExample
          ? { 'Content-Type': 'application/json' }
          : { 'Content-Type': sourceMime(source.file) || 'video/mp4', 'X-Upload-Filename': encodeURIComponent(source.file.name) },
        body: isExample ? JSON.stringify({ exampleId: source.example.id }) : source.file,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await responseError(response));
      const created = await response.json() as { id: string; token: string; status: JobStatus };
      if (!mounted.current || controller.signal.aborted) return;
      if (!created.id || !created.token) throw new Error('The demo returned an incomplete job. Please try again.');
      const next: Job = { ...created, startedAt, label: source.label, exampleId: isExample ? source.example.id : undefined };
      saveJob(next);
      setJob(next);
    } catch (error) {
      if (!isAbort(error) && mounted.current) setInputError(errorMessage(error, 'Your video could not be submitted. Please try again.'));
    } finally {
      if (mounted.current && requestController.current === controller) setIsUploading(false);
    }
  }

  async function cancelTranslation() {
    if (await removeJob()) setInputError('Translation cancelled. Your video is ready to try again.');
  }

  async function deleteVideo() {
    if (!(await removeJob())) return;
    stopCamera();
    setSource(null);
    setInputError('');
  }

  function checkAgain() {
    setJob(current => current ? { ...current, status: 'queued', pollingFailed: false, error: undefined } : current);
    setPollRevision(value => value + 1);
  }

  async function copyTranslation() {
    if (!job?.text) return;
    try {
      await navigator.clipboard.writeText(job.text);
      setCopied(true);
      window.setTimeout(() => { if (mounted.current) setCopied(false); }, 1800);
    } catch { setInputError('Copy was unavailable. You can select and copy the translation text.'); }
  }

  const statusLabel = isUploading ? 'Sending your video' : job?.stage === 'stalled' ? 'Taking longer than expected' : job?.stage === 'retrying' ? 'Retrying your translation' : job?.status === 'queued' ? 'Waiting for the model' : 'Reading the signs';
  const processingMessage = networkNote || (isUploading ? 'Keep this page open while your video is sent.' : job?.stage === 'stalled' ? 'Processing has stalled. You can wait for recovery or cancel this translation.' : job?.stage === 'retrying' ? 'The service is trying again after an interruption. Your video remains in the same job.' : job?.status === 'queued' ? 'Your clip is in the queue. We’ll show the result here.' : 'The C5 model is turning your clip into English.');
  const limitsText = config ? `Up to ${config.limits.maxDurationSeconds} seconds · ${formatBytes(config.limits.maxBytes)} maximum` : 'Loading video limits…';

  return <>
    <a className="skip-link" href="#demo">Skip to the demo</a>
    <header className="site-header"><div className="header-content shell">
      <Brand light />
      <nav aria-label="Main navigation">
        <a href="#about" className="nav-link">About the demo</a>
        <a href="https://umi.vision" target="_blank" rel="noreferrer" className="umi-link">umi.vision<Icon name="arrow" size={15} /></a>
      </nav>
    </div></header>

    <main>
      <div className="hero-band"><section className="hero shell" aria-labelledby="hero-title">
        <div className="hero-copy">
          <div className="eyebrow">A UMI experiment / C5</div>
          <h1 id="hero-title">Your signs.<br /><span>In English.</span></h1>
          <p>Record a video, upload a clip, or try an example.<br className="desktop-break" /> See the UMI C5 model translate it into English.</p>
        </div>
        <div className="hero-note">
          <span className="research-badge"><span aria-hidden="true" /> Research preview</span>
          <dl className="hero-specs"><div><dt>Input</dt><dd>ASL video</dd></div><div><dt>Model</dt><dd>UMI {config?.model.cohort || 'C5'}</dd></div><div><dt>Output</dt><dd>English</dd></div></dl>
          <span className="hero-model">Universal motion to meaning.</span>
        </div>
      </section></div>

      <section className="studio shell" id="demo" aria-labelledby="studio-title">
        <div className="studio-heading">
          <div className="section-label"><span className="section-number">01</span><h2 id="studio-title">Give it a sign</h2></div>
          <span className="studio-caption">Your video. The model’s words.</span>
        </div>

        {configError && <div className="notice notice-error" role="alert"><span>{configError}</span><button className="text-button" onClick={() => setConfigRevision(value => value + 1)}>Reconnect <Icon name="refresh" size={16} /></button></div>}
        {config && !modelReady && <div className="notice" role="status">The translation model is currently unavailable. You can explore the examples and prepare a video. Please check back soon.</div>}

        <div className="demo-panel">
          <div className="input-bar">
            <div className="mode-switch" role="group" aria-label="Choose a video source">
              <button className={mode === 'examples' ? 'mode-button active' : 'mode-button'} aria-pressed={mode === 'examples'} disabled={locked} onClick={() => void changeMode('examples')}><Icon name="play" size={17} /><span>Try an example</span></button>
              <button className={mode === 'upload' ? 'mode-button active' : 'mode-button'} aria-pressed={mode === 'upload'} disabled={locked} onClick={() => void changeMode('upload')}><Icon name="upload" size={17} /><span>Upload video</span></button>
              <button className={mode === 'record' ? 'mode-button active' : 'mode-button'} aria-pressed={mode === 'record'} disabled={locked} onClick={() => void changeMode('record')}><Icon name="camera" size={18} /><span>Record video</span></button>
            </div>
            <span className="input-limits">{config ? `${config.limits.maxDurationSeconds}s max` : 'Video to English'}</span>
          </div>

          <div className="workspace">
            <div className="video-column">
              <div className={`video-stage ${dragging ? 'dragging' : ''} ${cameraState === 'ready' || cameraState === 'recording' ? 'camera-active' : ''}`}
                onDragOver={event => { event.preventDefault(); if (!locked) setDragging(true); }}
                onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
                onDrop={onDrop}>
                {(cameraState === 'ready' || cameraState === 'recording') ? <>
                  <video className="camera-preview" ref={cameraVideo} autoPlay playsInline muted aria-label="Live camera preview" />
                  <div className="camera-topline"><span className={`camera-chip ${cameraState === 'recording' ? 'is-recording' : ''}`}><span />{cameraState === 'recording' ? `Recording ${formatDuration(recordedSeconds)}` : 'Camera preview'}</span><button className="icon-button dark-icon" aria-label="Close camera" onClick={() => stopCamera()}><Icon name="close" size={18} /></button></div>
                  <div className="camera-overlay">
                    {cameraState === 'ready' ? <><p>Keep your face, upper body, and hands in frame.</p><button className="button button-light" onClick={startRecording}><span className="record-dot" />Start recording</button></> : <><span className="recording-limit">{formatDuration(recordedSeconds)} / {formatDuration(config?.limits.maxDurationSeconds || 0)}</span><button className="button button-light" onClick={() => stopCamera(false)}><span className="stop-square" />Stop recording</button></>}
                  </div>
                </> : mode === 'record' && (!source || source.kind !== 'recording') ? <div className="video-placeholder">
                  <div className="placeholder-icon"><Icon name="camera" size={36} /></div>
                  <h3>A little space to sign.</h3><p>Find good light and frame your face,<br />upper body, and hands. Audio stays off.</p>
                  <button className="button button-light" disabled={!config || cameraState === 'requesting' || locked} onClick={() => void enableCamera()}>{cameraState === 'requesting' ? <><span className="spinner" />Waiting for camera…</> : <><Icon name="camera" size={18} />Enable camera</>}</button>
                  <span className="stage-fineprint">{limitsText}</span>
                </div> : previewUrl ? <>
                  <video className="selected-video" key={previewUrl} src={previewUrl} controls playsInline preload="metadata" aria-label={source?.label || 'Your video'} />
                  {busy && <div className="video-busy-badge"><span className="spinner" />{isUploading ? 'Sending video' : 'Translation in progress'}</div>}
                </> : <div className="video-placeholder">
                  {mode === 'upload' ? <div className="placeholder-icon"><Icon name="upload" size={36} /></div> : <HandsIllustration />}
                  <h3>{isValidating ? 'Getting your video ready…' : mode === 'upload' ? 'Your hands. Your words.' : source?.kind === 'restored' ? 'Your translation is saved here.' : 'Start with a little signing.'}</h3>
                  <p>{isValidating ? 'Checking the format and length.' : mode === 'upload' ? <>Drop a video here, or choose a file.<br />MP4, MOV, and WebM work best.</> : source?.kind === 'restored' ? 'The original preview is unavailable after a refresh.' : <>Choose an example below,<br />or bring a video of your own.</>}</p>
                  {mode === 'upload' ? <button className="button button-light" disabled={!config || locked} onClick={() => fileInput.current?.click()}><Icon name="upload" size={18} />Choose video</button> : <a className="stage-link" href="#examples">Explore the examples <Icon name="arrow" size={17} /></a>}
                  {mode === 'upload' && <span className="stage-fineprint">{limitsText}</span>}
                </div>}
                {dragging && <div className="drop-overlay"><Icon name="upload" size={40} /><strong>Drop your video here</strong></div>}
              </div>

              <div className="video-meta">
                <div className="video-meta-title"><Icon name={source ? 'file' : 'camera'} size={16} /><span>{source?.label || 'American Sign Language video'}</span></div>
                {source && 'duration' in source ? <span>{formatDuration(source.duration)}</span> : <span>ASL <span className="meta-divider">/</span> English</span>}
              </div>

              <div className="video-actions">
                {mode === 'upload' && source && <button className="text-button" disabled={locked} onClick={() => fileInput.current?.click()}><Icon name="upload" size={16} />Choose another video</button>}
                {mode === 'record' && source?.kind === 'recording' && <button className="text-button" disabled={locked} onClick={() => void enableCamera()}><Icon name="camera" size={16} />Record again</button>}
                {activeExample && <span className="example-description">{activeExample.description}</span>}
                {mode === 'upload' && !source && <span className="upload-hint">A short, steady clip with one signer works best.</span>}
              </div>
              {activeExample && <p className="example-privacy-note">Faces are blurred for display. The model processes the original clip.</p>}
              {(mode === 'upload' || mode === 'record') && <p className="input-optimization-note">Large frame sizes or high frame rates may be reduced for inference, without cropping or shortening your clip.</p>}
              <input className="visually-hidden" ref={fileInput} type="file" accept="video/mp4,video/webm,video/quicktime,video/x-m4v,.mp4,.mov,.webm,.m4v" onChange={onFileChange} tabIndex={-1} aria-label="Choose a video file" />
            </div>

            <aside className={`result-column ${job?.status === 'complete' ? 'has-result' : ''}`} aria-labelledby="result-heading" aria-busy={busy}>
              <div className="result-topline"><span className="result-eyebrow">The translation</span><span className="language-pill">English</span></div>
              <div className="result-body" aria-live="polite" aria-atomic="true">
                {busy ? <div className="processing-state"><span className="processing-symbol" aria-hidden="true"><span /><span /><span /><span /><span /></span><h3 id="result-heading">{statusLabel}<span className="animated-dots">…</span></h3><p>{processingMessage}</p><div className="indeterminate-progress" role="progressbar" aria-label={statusLabel}><span /></div><div className="processing-footer"><span><Icon name="clock" size={14} />{formatDuration(elapsed)} elapsed</span><span>{isUploading ? 'Sending' : job?.stage === 'stalled' ? 'Stalled' : job?.stage === 'retrying' ? 'Retrying' : job?.status === 'queued' ? 'Queued' : 'Processing'}</span></div><p className="timing-note">{job?.stage === 'stalled' || job?.stage === 'retrying' ? 'A completion estimate is unavailable while the service recovers.' : 'Timing depends on clip length and current demand.'}</p></div>
                  : job?.status === 'complete' ? <div className="translation-state"><span className="result-success"><Icon name="check" size={14} />Translation ready</span><h3 id="result-heading" ref={resultHeading} tabIndex={-1} className="translation-text">{job.text || 'No translation was returned for this clip.'}</h3><p className="result-model">Generated by {job.model?.name || config?.model.name || 'the C5 model'}{typeof job.elapsedSeconds === 'number' ? ` · ${formatDuration(job.elapsedSeconds)}` : ''}</p>{job.preprocessing?.normalized === true && <p className="normalized-note">Video optimized for inference. Full framing and clip length preserved.</p>}{job.text && <button className="text-button copy-button" onClick={() => void copyTranslation()}>{copied ? <><Icon name="check" size={15} />Copied</> : 'Copy translation'}</button>}</div>
                    : job?.status === 'failed' ? <div className="failed-state"><span className="failure-icon"><Icon name="refresh" size={23} /></span><h3 id="result-heading">Let’s try that again.</h3><p>{job.error || 'The model could not translate this video. Try a shorter, clearer clip.'}</p></div>
                      : <div className="result-empty"><span className="quote-mark" aria-hidden="true">“</span><h3 id="result-heading">The meaning,<br />in words.</h3><p>{source ? 'Your video is ready. Start the translation to see what the model reads.' : 'Choose a video and its English translation will appear here.'}</p></div>}
              </div>

              <div className="result-controls">
                {busy ? <button className="button button-outline" onClick={() => void cancelTranslation()} disabled={isDeleting}><Icon name="close" size={17} />{isDeleting ? 'Cancelling…' : 'Cancel translation'}</button>
                  : job?.pollingFailed ? <button className="button button-primary" onClick={checkAgain} disabled={isDeleting}><Icon name="refresh" size={17} />Check translation again</button>
                    : <button className="button button-primary" onClick={() => void translate()} disabled={!source || source.kind === 'restored' || !modelReady || locked || cameraState !== 'off'}>{isDeleting ? <><span className="spinner" />Removing previous video…</> : job?.status === 'complete' ? <><Icon name="refresh" size={17} />Translate again</> : job?.status === 'failed' ? <><Icon name="refresh" size={17} />Try translation again</> : <>Translate video <Icon name="arrow" size={19} /></>}</button>}
                {job && !busy ? <button className="delete-button" onClick={() => void deleteVideo()} disabled={isDeleting}><Icon name="trash" size={14} />{isDeleting ? 'Deleting…' : 'Delete video & result'}</button> : <p className="result-footnote">Model output may be incomplete or inaccurate.</p>}
              </div>
            </aside>
          </div>
          {(inputError || cameraError) && <div className="input-notice" role="alert"><span>{cameraError || inputError}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => { setInputError(''); setCameraError(''); }}><Icon name="close" size={16} /></button></div>}
          <div className="studio-footer"><span><span className="status-dot" aria-hidden="true" />{config ? `${config.model.cohort} model` : 'Connecting to the demo'}<span className="footer-separator">/</span>Research preview</span><a href="#privacy">How your video is handled <Icon name="arrow" size={13} /></a></div>
        </div>
      </section>

      <section className="examples-section shell" id="examples" aria-labelledby="examples-title">
        <div className="examples-heading"><div><div className="eyebrow subtle">A good place to start</div><h2 id="examples-title">Fingerspelling examples.</h2></div><p>Curated public clips, selected for this demo.</p></div>
        <div className="example-grid">
          {!config && !configError ? [1, 2, 3].map(number => <div key={number} className="example-skeleton" aria-hidden="true"><div /><span /><span /></div>)
            : config?.examples.length ? config.examples.map((example, index) => <button key={example.id} className={`example-card ${activeExample?.id === example.id ? 'selected' : ''}`} onClick={() => void chooseExample(example)} disabled={locked} aria-pressed={activeExample?.id === example.id} aria-label={`Select example: ${example.title}`}>
              <div className="example-preview"><video src={videoPreviewUrl(example.videoUrl)} muted playsInline preload="metadata" tabIndex={-1} aria-hidden="true" /><span className="example-index">{String(index + 1).padStart(2, '0')}</span><span className="example-play"><Icon name={activeExample?.id === example.id ? 'check' : 'play'} size={17} /></span>{activeExample?.id === example.id && <span className="selected-label">Selected</span>}</div>
              <div className="example-card-body"><h3>{example.title}</h3><Icon name="arrow" size={18} /><p>{example.description}</p><span className="example-attribution">{attributionLabel(example.attribution)}</span></div>
            </button>) : <div className="empty-examples"><Icon name="camera" size={24} /><p>{configError ? 'Examples will appear when the connection is restored.' : 'Example clips are being prepared. You can still upload or record a video above.'}</p></div>}
        </div>
        {Boolean(config?.examples.length) && <p className="gallery-context">These examples use public training clips and show selected outcomes. They are separate from an independent accuracy evaluation.</p>}
        {activeExample?.reference && <details className="reference-details"><summary>Reference translation for “{activeExample.title}”</summary><p>{activeExample.reference}</p><span>This supplied reference is separate from the model’s output.</span></details>}
        {activeExample && typeof activeExample.attribution !== 'string' && <details className="reference-details"><summary>Clip source & license</summary><p>{attributionLabel(activeExample.attribution)}<br /><a href={activeExample.attribution.url} target="_blank" rel="noreferrer">View source</a><span aria-hidden="true"> · </span><a href={activeExample.attribution.licenseUrl} target="_blank" rel="noreferrer">View license</a></p><span>{activeExample.attribution.changes}</span></details>}
      </section>

      <section className="about-section shell" id="about" aria-labelledby="about-title">
        <div className="about-heading"><span className="section-number">02</span><h2 id="about-title">A window into<br />what’s possible.</h2></div>
        <div className="about-copy"><p>bitsign explores how machine learning can help bring sign language into more everyday conversations. This demo runs the UMI C5 model on a video and shares its English translation.</p><p>Signing is expressive and full of context. This is a research preview, and results will vary with the signer, framing, and clip. It produces a translation for the whole clip.</p><a href="https://umi.vision" target="_blank" rel="noreferrer" className="text-button">Explore UMI <Icon name="arrow" size={17} /></a></div>
      </section>

      <section className="privacy-section shell" id="privacy" aria-labelledby="privacy-title"><details><summary id="privacy-title">Your video & this demo <span>Privacy and model details</span><Icon name="chevron" size={17} /></summary><div className="privacy-content"><p>Your video is sent to the demo service to generate a translation. Uploaded videos are removed after processing finishes. Results expire after 24 hours. Use “Delete video & result” to request removal sooner. Upload only videos you have permission to share.</p><p>The current job is remembered in this browser tab so you can return to its result after refreshing. Closing the tab clears that local access record. Deleting the job removes it from this tab too.</p>{config && <p>Model: {config.model.name}. Cohort: {config.model.cohort}. License: {config.model.license}. <span className="model-identity">Model identity: {config.model.id}</span></p>}</div></details></section>
    </main>

    <footer className="site-footer shell"><Brand /><span>More understanding, one sign at a time.</span><a href="https://umi.vision" target="_blank" rel="noreferrer">An experiment by UMI <Icon name="arrow" size={14} /></a></footer>
  </>;
}
