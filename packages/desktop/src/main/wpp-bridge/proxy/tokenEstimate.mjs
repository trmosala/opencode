// Single source of truth for token estimation across the proxy.
//
// This is a HEURISTIC, not a real tokenizer. The repo has zero runtime deps and reaches the
// model through the authenticated iframe bridge (no API key), so we can't call Anthropic's
// /v1/messages/count_tokens endpoint or bundle its tokenizer. The numbers here only feed
// OpenCode's context-window gauge, so we deliberately bias toward a slight OVER-estimate:
// over-counting nudges users to compact early (safe); under-counting risks a hard context
// overflow (bad).
//
// Baseline ratio: Claude Opus 4.7+ introduced a tokenizer that produces ~30% more tokens than
// older models for the same text. 4 chars/token / 1.3 ≈ 3.1; rounded to 3 chars/token, which
// also folds in the over-estimate bias. Opus 4.8 (the only model O1-Code serves today) is in
// that new-tokenizer family, so this is baked in as the baseline. To add a second tokenizer
// era later, branch on the model id here rather than threading a ratio through callers.
//
// NOTE: effort/reasoning level (High/Medium/Low) and prior-turn thinking blocks are OUTPUT-side
// concerns and are intentionally NOT modeled here — they don't change how the input text
// tokenizes, and the context-window gauge only cares about input size.
export const CHARS_PER_TOKEN = 3;

// Flat per-image FALLBACK cost, used only when we can't read an image's pixel dimensions from
// its header bytes (see src/imageDimensions.mjs). When dimensions ARE available we compute the
// real visual-token cost instead (see below). Kept near a typical full-size image's cost.
export const IMAGE_TOKEN_COST = 1500;

// Anthropic counts images in "visual tokens": one per 28x28 px patch, after resizing the image
// to fit the model's native resolution. Opus 4.8 (the only model O1-Code serves today) is in
// the high-resolution tokenizer family: max 2576 px on the long edge and at most 4784 visual
// tokens per image. These constants + the resize/patch math below mirror Anthropic's published
// reference implementation in the vision docs. To add another model era later, thread different
// limits through resizedImageSize/estimateImageTokensFromDimensions.
const IMAGE_PATCH_SIZE = 28;
const IMAGE_MAX_EDGE = 2576;
const IMAGE_MAX_TOKENS = 4784;

export function estimateTokens(value) {
  return Math.ceil(String(value || "").length / CHARS_PER_TOKEN);
}

// Visual-token cost of an image at a given pixel size: one token per 28x28 patch.
export function countImageTokens(width, height) {
  return Math.ceil(width / IMAGE_PATCH_SIZE) * Math.ceil(height / IMAGE_PATCH_SIZE);
}

function imageFits(width, height, maxEdge, maxTokens) {
  return Math.ceil(width / IMAGE_PATCH_SIZE) * IMAGE_PATCH_SIZE <= maxEdge
    && Math.ceil(height / IMAGE_PATCH_SIZE) * IMAGE_PATCH_SIZE <= maxEdge
    && countImageTokens(width, height) <= maxTokens;
}

// The size Claude resizes an image to before padding: the largest aspect-preserving size that
// satisfies both the edge limit and the visual-token budget. Mirrors the docs' binary search.
export function resizedImageSize(width, height, maxEdge = IMAGE_MAX_EDGE, maxTokens = IMAGE_MAX_TOKENS) {
  if (imageFits(width, height, maxEdge, maxTokens)) {
    return { width, height };
  }

  if (height > width) {
    const swapped = resizedImageSize(height, width, maxEdge, maxTokens);
    return { width: swapped.height, height: swapped.width };
  }

  const aspectRatio = width / height;
  let lo = 1; // always fits
  let hi = width; // never fits

  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (imageFits(mid, Math.max(Math.round(mid / aspectRatio), 1), maxEdge, maxTokens)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return { width: lo, height: Math.max(Math.round(lo / aspectRatio), 1) };
}

// Accurate per-image visual-token cost from pixel dimensions, or null when dimensions are
// missing/invalid (caller falls back to IMAGE_TOKEN_COST).
export function estimateImageTokensFromDimensions(width, height) {
  const w = Number(width);
  const h = Number(height);

  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return null;
  }

  const resized = resizedImageSize(w, h);
  return countImageTokens(resized.width, resized.height);
}

// Sum the visual-token cost across image inputs. Each image uses its real dimension-derived cost
// when width/height are known, falling back to the flat IMAGE_TOKEN_COST otherwise. Accepts an
// array of image objects ({ width, height }); a bare number is treated as a dimensionless count.
export function estimateImageTokens(images = []) {
  if (typeof images === "number") {
    return Math.max(0, images) * IMAGE_TOKEN_COST;
  }

  const list = Array.isArray(images) ? images : [];

  return list.reduce((total, image) => {
    const fromDimensions = estimateImageTokensFromDimensions(image?.width, image?.height);
    return total + (fromDimensions == null ? IMAGE_TOKEN_COST : fromDimensions);
  }, 0);
}
