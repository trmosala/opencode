import { randomBytes } from "node:crypto"
import { MAX_SCREENSHOT_BYTES } from "@cookiemonster/cm-browser/protocol"

export const VISUAL_MIN_SCALE = 0.5
export const VISUAL_QUALITY_STEPS = [82, 72, 62, 52] as const
export const VISUAL_SCALE_STEPS = [1, 0.8, 0.65, VISUAL_MIN_SCALE] as const

export type VisualLease = {
  readonly visualRef: string
  readonly tabID: string
  readonly url: string
  readonly documentToken: string
  readonly layoutToken: string
  readonly dpr: number
  readonly viewportWidth: number
  readonly viewportHeight: number
  readonly scrollX: number
  readonly scrollY: number
  readonly clipX: number
  readonly clipY: number
  readonly scaleX: number
  readonly scaleY: number
  readonly width: number
  readonly height: number
  readonly owner: string
  readonly captureScale: number
  readonly sourceDigest: string
  readonly frameSignature: string
  readonly documentSignature: string
}

// This isolated-world state changes on DOM, viewport, scroll, and observed layout changes.
// Animation-driven movement is sampled on animation frames while the document has active animations.
export const visualGuardScript = `(async () => {
  const root = document.documentElement;
  if (!root) return null;
  let state = globalThis.__cmVisualGuard;
  if (!state || state.document !== document || state.root !== root) {
    const token = () => Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16).padStart(8, '0')).join('');
    state = globalThis.__cmVisualGuard = {
      document, root, documentToken: token(), layoutToken: token(),
      width: visualViewport?.width ?? innerWidth, height: visualViewport?.height ?? innerHeight,
      scrollX: visualViewport?.pageLeft ?? scrollX, scrollY: visualViewport?.pageTop ?? scrollY, dpr: devicePixelRatio,
      mutation: null, resize: null, frame: 0, blocked: false,
    };
    const invalidate = () => { state.layoutToken = token(); };
    state.mutation = new MutationObserver(invalidate);
    state.mutation.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    state.resize = new ResizeObserver(invalidate);
    state.resize.observe(root);
    addEventListener('scroll', invalidate, true);
    addEventListener('resize', invalidate, true);
    visualViewport?.addEventListener('scroll', invalidate);
    visualViewport?.addEventListener('resize', invalidate);
    const sample = () => {
      const width = visualViewport?.width ?? innerWidth, height = visualViewport?.height ?? innerHeight;
      const x = visualViewport?.pageLeft ?? scrollX, y = visualViewport?.pageTop ?? scrollY;
      if (width !== state.width || height !== state.height || x !== state.scrollX || y !== state.scrollY || devicePixelRatio !== state.dpr) {
        state.width = width; state.height = height; state.scrollX = x; state.scrollY = y; state.dpr = devicePixelRatio; invalidate();
      }
      const animations = document.getAnimations().filter(item => item.playState === 'running');
      if (animations.length) {
        state.blocked = true;
        invalidate();
        state.frame = requestAnimationFrame(sample);
        return;
      }
      state.blocked = false;
    };
    state.sample = sample;
  }
  cancelAnimationFrame(state.frame);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  state.sample();
  return { documentToken: state.documentToken, layoutToken: state.layoutToken, width: visualViewport?.width ?? innerWidth,
    height: visualViewport?.height ?? innerHeight, dpr: devicePixelRatio,
    scrollX: visualViewport?.pageLeft ?? scrollX, scrollY: visualViewport?.pageTop ?? scrollY, animated: state.blocked };
})()`

export function newVisualRef() {
  const bytes = randomBytes(16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function boundedJpeg(
  source: Buffer,
  resize: (bytes: Buffer, width: number, height: number, quality: number) => Buffer,
  sourceWidth: number,
  sourceHeight: number,
  minimumScale = VISUAL_MIN_SCALE,
) {
  for (const scale of [...new Set([1, ...VISUAL_SCALE_STEPS, minimumScale])]
    .filter((scale) => scale >= minimumScale)
    .sort((a, b) => b - a)) {
    const width = Math.max(1, Math.ceil(sourceWidth * scale))
    const height = Math.max(1, Math.ceil(sourceHeight * scale))
    for (const quality of VISUAL_QUALITY_STEPS) {
      const bytes = resize(source, width, height, quality)
      if (bytes.length <= MAX_SCREENSHOT_BYTES)
        return { bytes, width, height, scaleX: width / sourceWidth, scaleY: height / sourceHeight }
    }
  }
}

export function validCapturedJpeg(value: unknown) {
  if (typeof value !== "string" || value.length > 8_388_608 || value.length % 4 !== 0) return
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return
  const bytes = Buffer.from(value, "base64")
  if (
    bytes.length > 6_291_456 ||
    bytes.toString("base64") !== value ||
    bytes[0] !== 255 ||
    bytes[1] !== 216 ||
    bytes[2] !== 255 ||
    bytes.at(-2) !== 255 ||
    bytes.at(-1) !== 217
  )
    return
  return bytes
}

export function visualPoint(lease: VisualLease, x: number, y: number) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= lease.width || y >= lease.height) return
  return {
    x: (x + 0.5) / lease.scaleX,
    y: (y + 0.5) / lease.scaleY,
  }
}
