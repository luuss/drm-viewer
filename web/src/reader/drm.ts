import { getRawImageData } from "./canvasPoison";

export function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function applyInvisibleWatermark(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  sessionId: string,
  row: number,
  col: number,
) {
  const seed = hashCode(`${sessionId}:${row}:${col}`);
  const rng = mulberry32(seed);
  const imgData = getRawImageData(ctx, w, h);
  const d = imgData.data;
  for (let i = 0; i < 20; i++) {
    const px = Math.floor(rng() * (w * h));
    const idx = px * 4;
    const channel = Math.floor(rng() * 3);
    const delta = rng() > 0.5 ? 1 : -1;
    d[idx + channel] = Math.max(0, Math.min(255, d[idx + channel] + delta));
  }
  ctx.putImageData(imgData, 0, 0);
}

export function drawNoise(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const imageData = ctx.createImageData(canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const v = Math.random() * 30;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 8;
  }
  ctx.putImageData(imageData, 0, 0);
}
