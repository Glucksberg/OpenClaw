import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildImageResizeSideGrid,
  getImageMetadata,
  IMAGE_REDUCE_QUALITY_STEPS,
  resizeToJpeg,
} from "../media/image-ops.js";
import {
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_IMAGE_MAX_DIMENSION_PX,
  type ImageSanitizationLimits,
} from "./image-sanitization.js";

type ToolContentBlock = AgentToolResult<unknown>["content"][number];
type ImageContentBlock = Extract<ToolContentBlock, { type: "image" }>;
type TextContentBlock = Extract<ToolContentBlock, { type: "text" }>;

// Anthropic Messages API limitations (observed in OpenClaw sessions):
// - Images over ~2000px per side can fail in multi-image requests.
// - Images over 5MB are rejected by the API.
//
// To keep sessions resilient (and avoid "silent" WhatsApp non-replies), we auto-downscale
// and recompress base64 image blocks when they exceed these limits.
const MAX_IMAGE_DIMENSION_PX = DEFAULT_IMAGE_MAX_DIMENSION_PX;
const MAX_IMAGE_BYTES = DEFAULT_IMAGE_MAX_BYTES;
const log = createSubsystemLogger("agents/tool-images");

function isImageBlock(block: unknown): block is ImageContentBlock {
  if (!block || typeof block !== "object") {
    return false;
  }
  const rec = block as Record<string, unknown>;
  return rec.type === "image" && typeof rec.data === "string" && typeof rec.mimeType === "string";
}

function isTextBlock(block: unknown): block is TextContentBlock {
  if (!block || typeof block !== "object") {
    return false;
  }
  const rec = block as Record<string, unknown>;
  return rec.type === "text" && typeof rec.text === "string";
}

function inferMimeTypeFromBase64(base64: string): string | undefined {
  const trimmed = base64.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("/9j/")) {
    return "image/jpeg";
  }
  if (trimmed.startsWith("iVBOR")) {
    return "image/png";
  }
  if (trimmed.startsWith("R0lGOD")) {
    return "image/gif";
  }
  return undefined;
}

function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${Math.max(0, Math.round(bytes))}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

async function resizeImageBase64IfNeeded(params: {
  base64: string;
  mimeType: string;
  maxDimensionPx: number;
  maxBytes: number;
  label?: string;
}): Promise<{
  base64: string;
  mimeType: string;
  resized: boolean;
  width?: number;
  height?: number;
}> {
  const buf = Buffer.from(params.base64, "base64");
  const meta = await getImageMetadata(buf);
  const width = meta?.width;
  const height = meta?.height;
  // Compare base64 string length, not decoded buffer size.
  // The Anthropic API enforces the 5MB limit on the base64 string, which is ~33% larger than the decoded bytes.
  const base64Length = params.base64.length;
  const overBytes = base64Length > params.maxBytes;
  const hasDimensions = typeof width === "number" && typeof height === "number";
  const overDimensions =
    hasDimensions && (width > params.maxDimensionPx || height > params.maxDimensionPx);
  if (
    hasDimensions &&
    !overBytes &&
    width <= params.maxDimensionPx &&
    height <= params.maxDimensionPx
  ) {
    return {
      base64: params.base64,
      mimeType: params.mimeType,
      resized: false,
      width,
      height,
    };
  }
  if (
    hasDimensions &&
    (width > params.maxDimensionPx || height > params.maxDimensionPx || overBytes)
  ) {
    const sourcePixels =
      typeof width === "number" && typeof height === "number"
        ? `${width}x${height}px`
        : "unknown";
    log.warn(
      `Image exceeds limits; resizing: ${sourcePixels} base64=${base64Length}`,
      {
        label: params.label,
        width,
        height,
        maxDimensionPx: params.maxDimensionPx,
        maxBytes: params.maxBytes,
        base64Length,
        triggerOverBytes: overBytes,
        triggerOverDimensions: overDimensions,
      },
    );
  }

  const maxDim = hasDimensions ? Math.max(width ?? 0, height ?? 0) : params.maxDimensionPx;
  const sideStart = maxDim > 0 ? Math.min(params.maxDimensionPx, maxDim) : params.maxDimensionPx;
  const sideGrid = buildImageResizeSideGrid(params.maxDimensionPx, sideStart);

  let smallest: { base64: string; size: number } | null = null;
  for (const side of sideGrid) {
    for (const quality of IMAGE_REDUCE_QUALITY_STEPS) {
      const out = await resizeToJpeg({
        buffer: buf,
        maxSide: side,
        quality,
        withoutEnlargement: true,
      });
      const outBase64 = out.toString("base64");
      const outBase64Length = outBase64.length;
      if (!smallest || outBase64Length < smallest.size) {
        smallest = { base64: outBase64, size: outBase64Length };
      }
      if (outBase64Length <= params.maxBytes) {
        const sourcePixels =
          typeof width === "number" && typeof height === "number"
            ? `${width}x${height}px`
            : "unknown";
        const reductionPct =
          base64Length > 0
            ? Number((((base64Length - outBase64Length) / base64Length) * 100).toFixed(1))
            : 0;
        log.info(
          `Image resized to fit limits: ${sourcePixels} base64 ${base64Length} -> ${outBase64Length} (-${reductionPct}%)`,
          {
            label: params.label,
            sourceMimeType: params.mimeType,
            sourceWidth: width,
            sourceHeight: height,
            sourceBase64Length: base64Length,
            maxBytes: params.maxBytes,
            maxDimensionPx: params.maxDimensionPx,
            triggerOverBytes: overBytes,
            triggerOverDimensions: overDimensions,
            outputMimeType: "image/jpeg",
            outputBase64Length: outBase64Length,
            outputQuality: quality,
            outputMaxSide: side,
            reductionPct,
          },
        );
        return {
          base64: outBase64,
          mimeType: "image/jpeg",
          resized: true,
          width,
          height,
        };
      }
    }
  }

  const bestBase64 = smallest?.base64 ?? params.base64;
  const bestSize = smallest?.size ?? base64Length;
  const maxMb = (params.maxBytes / (1024 * 1024)).toFixed(0);
  const gotMb = (bestSize / (1024 * 1024)).toFixed(2);
  const sourcePixels =
    typeof width === "number" && typeof height === "number" ? `${width}x${height}px` : "unknown";
  log.warn(
    `Image resize failed to fit limits: ${sourcePixels} bestBase64=${bestSize} limit=${params.maxBytes}`,
    {
      label: params.label,
      sourceMimeType: params.mimeType,
      sourceWidth: width,
      sourceHeight: height,
      sourceBase64Length: base64Length,
      maxDimensionPx: params.maxDimensionPx,
      maxBytes: params.maxBytes,
      smallestCandidateBase64Length: bestSize,
      triggerOverBytes: overBytes,
      triggerOverDimensions: overDimensions,
    },
  );
  throw new Error(`Image could not be reduced below ${maxMb}MB (got ${gotMb}MB)`);
}

export async function sanitizeContentBlocksImages(
  blocks: ToolContentBlock[],
  label: string,
  opts: ImageSanitizationLimits = {},
): Promise<ToolContentBlock[]> {
  const maxDimensionPx = Math.max(opts.maxDimensionPx ?? MAX_IMAGE_DIMENSION_PX, 1);
  const maxBytes = Math.max(opts.maxBytes ?? MAX_IMAGE_BYTES, 1);
  const out: ToolContentBlock[] = [];

  for (const block of blocks) {
    if (!isImageBlock(block)) {
      out.push(block);
      continue;
    }

    const data = block.data.trim();
    if (!data) {
      out.push({
        type: "text",
        text: `[${label}] omitted empty image payload`,
      } satisfies TextContentBlock);
      continue;
    }

    try {
      const inferredMimeType = inferMimeTypeFromBase64(data);
      const mimeType = inferredMimeType ?? block.mimeType;
      const resized = await resizeImageBase64IfNeeded({
        base64: data,
        mimeType,
        maxDimensionPx,
        maxBytes,
        label,
      });
      out.push({
        ...block,
        data: resized.base64,
        mimeType: resized.resized ? resized.mimeType : mimeType,
      });
    } catch (err) {
      out.push({
        type: "text",
        text: `[${label}] omitted image payload: ${String(err)}`,
      } satisfies TextContentBlock);
    }
  }

  return out;
}

export async function sanitizeImageBlocks(
  images: ImageContent[],
  label: string,
  opts: ImageSanitizationLimits = {},
): Promise<{ images: ImageContent[]; dropped: number }> {
  if (images.length === 0) {
    return { images, dropped: 0 };
  }
  const sanitized = await sanitizeContentBlocksImages(images as ToolContentBlock[], label, opts);
  const next = sanitized.filter(isImageBlock);
  return { images: next, dropped: Math.max(0, images.length - next.length) };
}

export async function sanitizeToolResultImages(
  result: AgentToolResult<unknown>,
  label: string,
  opts: ImageSanitizationLimits = {},
): Promise<AgentToolResult<unknown>> {
  const content = Array.isArray(result.content) ? result.content : [];
  if (!content.some((b) => isImageBlock(b) || isTextBlock(b))) {
    return result;
  }

  const next = await sanitizeContentBlocksImages(content, label, opts);
  return { ...result, content: next };
}
