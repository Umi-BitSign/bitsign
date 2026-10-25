// The C5 model's per-frame inputs, computed in the browser so that video never
// leaves the page. For each frame this returns what the server's pipeline
// (vendor/demo in the C5 bundle) would compute: 14 normalised pose values and
// 384-wide DINOv2 embeddings of the left hand, right hand and face crops. The
// crop rules below follow crop_hands.py, crop_face.py and body_features.py
// line by line, including Python's integer truncation and the fallbacks to the
// previous crop, because the translator was trained on exactly those inputs.

const CROP = 224;
const HAND_SCALE = 1.5;
const HAND_DISTANCE = 0.1;
const FACE_PADDING = 10;
const GREY = 128;
const LEFT_EYE = [69, 168, 156, 118, 54];
const RIGHT_EYE = [168, 299, 347, 336, 301];
const MOUTH = [164, 212, 432, 18];
const POSE_POINTS = [0, 11, 12, 13, 14, 15, 16];
const MISSING = -9999;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// OpenCV's INTER_AREA: exact box averaging when shrinking, and linear
// interpolation with area-derived weights when enlarging. Crops are square,
// so one axis plan serves both directions.
function areaPlan(source, target) {
  const scale = source / target;
  const plan = [];
  if (scale >= 1) {
    for (let d = 0; d < target; d++) {
      const start = d * scale;
      const end = start + scale;
      const taps = [];
      for (let s = Math.floor(start); s < Math.ceil(end) && s < source; s++) {
        const weight = Math.min(end, s + 1) - Math.max(start, s);
        if (weight > 1e-9) taps.push([s, weight / scale]);
      }
      plan.push(taps);
    }
  } else {
    for (let d = 0; d < target; d++) {
      const s = Math.floor(d * scale);
      let f = d + 1 - (s + 1) / scale;
      f = f <= 0 ? 0 : f - Math.floor(f);
      const a = Math.min(Math.max(s, 0), source - 1);
      const b = Math.min(s + 1, source - 1);
      plan.push(f === 0 || a === b ? [[a, 1]] : [[a, 1 - f], [b, f]]);
    }
  }
  return plan;
}

function resizeArea(rgb, width, height, size = CROP) {
  const xs = areaPlan(width, size);
  const ys = areaPlan(height, size);
  const rows = new Float32Array(height * size * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (const [s, w] of xs[x]) {
        const i = (y * width + s) * 3;
        r += rgb[i] * w; g += rgb[i + 1] * w; b += rgb[i + 2] * w;
      }
      const o = (y * size + x) * 3;
      rows[o] = r; rows[o + 1] = g; rows[o + 2] = b;
    }
  }
  const out = new Uint8ClampedArray(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (const [s, w] of ys[y]) {
        const i = (s * size + x) * 3;
        r += rows[i] * w; g += rows[i + 1] * w; b += rows[i + 2] * w;
      }
      const o = (y * size + x) * 3;
      out[o] = Math.round(r); out[o + 1] = Math.round(g); out[o + 2] = Math.round(b);
    }
  }
  return out;
}

// Python slice bounds, so negative starts wrap the way numpy indexing does.
function sliceBounds(start, stop, length) {
  const fix = (v) => (v < 0 ? Math.max(v + length, 0) : Math.min(v, length));
  const a = fix(start);
  return [a, Math.max(fix(stop), a)];
}

function cut(frame, x1, x2, y1, y2) {
  const [xa, xb] = sliceBounds(x1, x2, frame.width);
  const [ya, yb] = sliceBounds(y1, y2, frame.height);
  const width = xb - xa;
  const height = yb - ya;
  const rgb = new Uint8ClampedArray(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = ((ya + y) * frame.width + xa + x) * 3;
      const o = (y * width + x) * 3;
      rgb[o] = frame.rgb[i]; rgb[o + 1] = frame.rgb[i + 1]; rgb[o + 2] = frame.rgb[i + 2];
    }
  }
  return { rgb, width, height };
}

function handCrop(frame, hand) {
  const px = hand.map((p) => [Math.trunc(p.x * frame.width), Math.trunc(p.y * frame.height)]);
  const cx = Math.trunc(px.reduce((sum, p) => sum + p[0], 0) / px.length);
  const cy = Math.trunc(px.reduce((sum, p) => sum + p[1], 0) / px.length);
  const xsAll = px.map((p) => p[0]);
  const ysAll = px.map((p) => p[1]);
  const wb = Math.max(...xsAll) - Math.min(...xsAll) + 1;
  const hb = Math.max(...ysAll) - Math.min(...ysAll) + 1;
  const box = Math.max(wb, hb);
  const half = Math.floor(box / 2);
  const pad = Math.trunc(((HAND_SCALE - 1) * box) / 2);
  let x = cx - half - pad;
  let y = cy - half - pad;
  const side = box + 2 * pad;
  if (x + side > frame.width) x = frame.width - side;
  if (y + side > frame.height) y = frame.height - side;
  x = Math.max(x, 0);
  y = Math.max(y, 0);
  const crop = cut(frame, x, x + side, y, y + side);
  return crop.width && crop.height ? resizeArea(crop.rgb, crop.width, crop.height) : null;
}

function nearestHand(wrist, hands) {
  let best = 0;
  let distance = 100;
  hands.forEach((hand, i) => {
    const d = Math.hypot(wrist.x - hand[0].x, wrist.y - hand[0].y);
    if (d < distance) {
      distance = d;
      best = i;
    }
  });
  return distance < HAND_DISTANCE ? hands[best] : null;
}

function faceBox(frame, face, indices) {
  const xs = indices.map((i) => face[i].x);
  const ys = indices.map((i) => face[i].y);
  return [
    Math.trunc(Math.min(...xs) * frame.width),
    Math.trunc(Math.min(...ys) * frame.height),
    Math.trunc(Math.max(...xs) * frame.width),
    Math.trunc(Math.max(...ys) * frame.height),
  ];
}

function faceCrop(frame, face) {
  const boxes = [LEFT_EYE, RIGHT_EYE, MOUTH].map((indices) => faceBox(frame, face, indices));
  let minX = Math.max(0, Math.min(...boxes.map((b) => b[0])) - FACE_PADDING);
  let minY = Math.max(0, Math.min(...boxes.map((b) => b[1])) - FACE_PADDING);
  let maxX = Math.min(frame.width, Math.max(...boxes.map((b) => b[2])) + FACE_PADDING);
  let maxY = Math.min(frame.height, Math.max(...boxes.map((b) => b[3])) + FACE_PADDING);
  const width = maxX - minX;
  const height = maxY - minY;
  const side = Math.max(width, height);
  if (width < side) {
    const extra = side - width;
    minX = Math.max(0, minX - Math.floor(extra / 2));
    maxX = Math.min(frame.width, maxX + Math.floor(extra / 2));
  }
  if (height < side) {
    const extra = side - height;
    minY = Math.max(0, minY - Math.floor(extra / 2));
    maxY = Math.min(frame.height, maxY + Math.floor(extra / 2));
  }
  if (side <= 0) return null;
  const canvas = new Uint8ClampedArray(side * side * 3).fill(GREY);
  for (const [x1, y1, x2, y2] of boxes) {
    const piece = cut(frame, x1, x2, y1, y2);
    const dx = x1 - minX;
    const dy = y1 - minY;
    for (let y = 0; y < piece.height; y++) {
      const ty = dy + y;
      if (ty < 0 || ty >= side) continue;
      for (let x = 0; x < piece.width; x++) {
        const tx = dx + x;
        if (tx < 0 || tx >= side) continue;
        const i = (y * piece.width + x) * 3;
        const o = (ty * side + tx) * 3;
        canvas[o] = piece.rgb[i]; canvas[o + 1] = piece.rgb[i + 1]; canvas[o + 2] = piece.rgb[i + 2];
      }
    }
  }
  return resizeArea(canvas, side, side);
}

function nearestFace(nose, faces) {
  let best = 0;
  let distance = Infinity;
  faces.forEach((face, i) => {
    const d = Math.hypot(nose.x - face[0].x, nose.y - face[0].y, nose.z - face[0].z);
    if (d < distance) {
      distance = d;
      best = i;
    }
  });
  return faces[best];
}

function poseFeatures(pose) {
  if (!pose) return new Float32Array(POSE_POINTS.length * 2).fill(MISSING);
  const head = Math.hypot(pose[12].x - pose[11].x, pose[12].y - pose[11].y) / 2;
  const width = 6 * head;
  const height = 7 * head;
  const top = pose[2].y - 0.5 * head;
  const left = pose[0].x - width / 2;
  const out = new Float32Array(POSE_POINTS.length * 2);
  POSE_POINTS.forEach((p, i) => {
    out[2 * i] = (pose[p].x - left) / width - 0.5;
    out[2 * i + 1] = (pose[p].y - top) / height - 0.5;
  });
  return out;
}

function toPixels(crops) {
  const plane = CROP * CROP;
  const data = new Float32Array(crops.length * 3 * plane);
  crops.forEach((crop, n) => {
    for (let i = 0; i < plane; i++) {
      for (let c = 0; c < 3; c++) {
        data[n * 3 * plane + c * plane + i] = (crop[i * 3 + c] / 255 - MEAN[c]) / STD[c];
      }
    }
  });
  return data;
}

const blank = () => new Uint8ClampedArray(CROP * CROP * 3);

// Round-to-nearest-even float32 to IEEE half, for browsers without Float16Array.
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(value) {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exponent = (x >>> 23) & 0xff;
  let mantissa = x & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0);
  let e = exponent - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mantissa |= 0x800000;
    const shift = 14 - e;
    let half = mantissa >> shift;
    const rest = mantissa & ((1 << shift) - 1);
    const midpoint = 1 << (shift - 1);
    if (rest > midpoint || (rest === midpoint && half & 1)) half++;
    return sign | half;
  }
  let half = (e << 10) | (mantissa >> 13);
  const rest = mantissa & 0x1fff;
  if (rest > 0x1000 || (rest === 0x1000 && half & 1)) half++;
  return sign | half;
}

// The body services/vision/live_features.py decodes: b"BSF1", a uint32 frame
// count, face, left and right as float16 (frames x 384 each), then pose as
// float32 (frames x 14) so the -9999 "not seen" marker stays exact.
export function encodeFeatures(frames) {
  const n = frames.length;
  const buffer = new ArrayBuffer(8 + n * (3 * 384 * 2 + 14 * 4));
  const view = new DataView(buffer);
  [0x42, 0x53, 0x46, 0x31].forEach((byte, i) => view.setUint8(i, byte));
  view.setUint32(4, n, true);
  let offset = 8;
  for (const key of ["face", "left", "right"]) {
    for (const frame of frames) {
      for (let i = 0; i < 384; i++, offset += 2) view.setUint16(offset, toHalf(frame[key][i]), true);
    }
  }
  for (const frame of frames) {
    for (let i = 0; i < 14; i++, offset += 4) view.setFloat32(offset, frame.pose[i], true);
  }
  return buffer;
}

export class FeatureExtractor {
  static async create({ vision, wasm, models, ort, delegate = "GPU" }) {
    const { FilesetResolver, FaceLandmarker, HandLandmarker, PoseLandmarker } = await import(vision);
    const files = await FilesetResolver.forVisionTasks(wasm);
    const base = (path) => ({ modelAssetPath: path, delegate });
    // A model may be split into parts, since static hosting caps each file at 25 MB.
    const bytes = async (paths) => {
      const parts = await Promise.all(
        paths.map(async (path) => {
          const response = await fetch(path);
          if (!response.ok) throw new Error(`could not load ${path}`);
          return new Uint8Array(await response.arrayBuffer());
        }),
      );
      const whole = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      parts.reduce((offset, part) => (whole.set(part, offset), offset + part.length), 0);
      return whole;
    };
    const session = async (path) =>
      ort.InferenceSession.create(Array.isArray(path) ? await bytes(path) : path, {
        executionProviders: ["webgpu", "wasm"],
      });
    const dinoHand = await session(models.dinoHand);
    const dinoFace = await session(models.dinoFace);
    const [face, hand, pose] = await Promise.all([
      FaceLandmarker.createFromOptions(files, { baseOptions: base(models.face), runningMode: "IMAGE", numFaces: 6 }),
      HandLandmarker.createFromOptions(files, {
        baseOptions: base(models.hand), runningMode: "IMAGE", numHands: 6, minHandDetectionConfidence: 0.05,
      }),
      PoseLandmarker.createFromOptions(files, {
        baseOptions: base(models.pose), runningMode: "VIDEO", numPoses: 1, minPoseDetectionConfidence: 0.1,
      }),
    ]);
    return new FeatureExtractor({ face, hand, pose, dinoHand, dinoFace, ort });
  }

  constructor(parts) {
    Object.assign(this, parts);
    this.canvas = document.createElement("canvas");
    this.context = this.canvas.getContext("2d", { willReadFrequently: true });
    this.previous = { left: null, right: null, face: null };
  }

  reset() {
    this.previous = { left: null, right: null, face: null };
  }

  // One frame of `source` (a video, image or canvas) at `timestamp` ms, which
  // must increase from call to call.
  async push(source, timestamp) {
    const width = source.videoWidth || source.naturalWidth || source.width;
    const height = source.videoHeight || source.naturalHeight || source.height;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.context.drawImage(source, 0, 0, width, height);
    const rgba = this.context.getImageData(0, 0, width, height).data;
    const rgb = new Uint8ClampedArray(width * height * 3);
    for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
      rgb[o] = rgba[i]; rgb[o + 1] = rgba[i + 1]; rgb[o + 2] = rgba[i + 2];
    }
    const frame = { rgb, width, height };
    const timings = {};
    let t = performance.now();
    const pose = this.pose.detectForVideo(this.canvas, timestamp).landmarks[0] ?? null;
    const hands = this.hand.detect(this.canvas).landmarks;
    const faces = this.face.detect(this.canvas).faceLandmarks;
    timings.landmarks = performance.now() - t;
    t = performance.now();
    let { left, right, face } = this.previous;
    if (pose) {
      const leftHand = hands.length ? nearestHand(pose[15], hands) : null;
      const rightHand = hands.length ? nearestHand(pose[16], hands) : null;
      if (leftHand) left = handCrop(frame, leftHand) ?? left;
      if (rightHand) right = handCrop(frame, rightHand) ?? right;
      if (faces.length) face = faceCrop(frame, nearestFace(pose[0], faces)) ?? face;
    }
    this.previous = { left, right, face };
    timings.crops = performance.now() - t;
    t = performance.now();
    const handBatch = new this.ort.Tensor("float32", toPixels([left ?? blank(), right ?? blank()]), [2, 3, CROP, CROP]);
    const faceBatch = new this.ort.Tensor("float32", toPixels([face ?? blank()]), [1, 3, CROP, CROP]);
    const handOut = await this.dinoHand.run({ pixels: handBatch });
    const faceOut = await this.dinoFace.run({ pixels: faceBatch });
    timings.dino = performance.now() - t;
    const handData = handOut.embedding.data;
    return {
      pose: poseFeatures(pose),
      left: handData.slice(0, 384),
      right: handData.slice(384, 768),
      face: faceOut.embedding.data.slice(0, 384),
      hands: hands.length,
      timings,
      crops: { left, right, face },
    };
  }
}
