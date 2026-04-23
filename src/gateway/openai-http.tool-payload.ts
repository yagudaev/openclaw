// Tool payload serialization + truncation for `gen_ai.tool.input` /
// `gen_ai.tool.output` span attributes. Extracted from `openai-http.ts` so
// the logic can be unit-tested at seam depth (no gateway server or event bus
// needed).
//
// Three hazards this module must handle:
//   1. OTLP span attribute size ceiling: truncate serialized payload to
//      64 KiB of UTF-8 bytes (not UTF-16 code units — emoji / non-ASCII can
//      smuggle a much larger byte payload past a naive `.slice`).
//   2. OOM on huge raw payloads: a 50 MB browser snapshot passed to
//      `JSON.stringify` allocates a ~50 MB string before any truncation.
//      Guard with an early raw-size check and emit a fixed placeholder
//      instead of allocating the full string.
//   3. LANGFUSE_TRACE_CONTENT gate: structural metadata always flows, but
//      content-bearing attrs (input/output) are suppressed by default. The
//      gate lives in the caller; this module is content-agnostic.

// Max serialized UTF-8 byte length for a single `gen_ai.tool.<slot>`
// attribute. Langfuse / OTLP exporters reject oversized attributes.
export const TOOL_PAYLOAD_MAX_BYTES = 64 * 1024;

// Hard cap on the raw payload size we are willing to serialize (UTF-8 bytes
// for strings, estimated byte length for objects via a size-limited
// replacer). Above this we skip `JSON.stringify` entirely and emit a
// placeholder — a 50 MB tool result must not allocate a 50 MB JSON string
// just to be truncated down to 64 KiB on the next line.
export const TOOL_PAYLOAD_RAW_MAX_BYTES = 1024 * 1024;

export type ToolPayloadAttributes = {
  value: string;
  truncated: boolean;
};

// Serialize + byte-truncate a tool input/output payload for a
// `gen_ai.tool.<slot>` span attribute. Returns `undefined` when there is
// nothing to emit (null/undefined payload or serialization bailed out).
// Never throws — tracing must not break the request path.
export function buildToolPayloadAttribute(payload: unknown): ToolPayloadAttributes | undefined {
  const serialized = serializeToolPayload(payload);
  if (serialized === undefined) {
    return undefined;
  }
  return truncateUtf8(serialized, TOOL_PAYLOAD_MAX_BYTES);
}

// Best-effort serialization. Strings pass through so tool args/results that
// are already text (e.g. stdout) do not get double-stringified. Objects are
// JSON-encoded; circular/unserializable payloads return a fixed sentinel
// rather than risking `[object Object]` noise.
//
// Before calling `JSON.stringify`, we cheaply estimate the payload byte
// size. If it exceeds `TOOL_PAYLOAD_RAW_MAX_BYTES` we bail with a
// placeholder so a 50 MB payload does not allocate a 50 MB JSON string.
export function serializeToolPayload(payload: unknown): string | undefined {
  if (payload === undefined || payload === null) {
    return undefined;
  }
  if (typeof payload === "string") {
    if (Buffer.byteLength(payload, "utf8") > TOOL_PAYLOAD_RAW_MAX_BYTES) {
      return buildTruncatedPlaceholder();
    }
    return payload;
  }
  if (typeof payload === "number" || typeof payload === "boolean") {
    return String(payload);
  }
  return stringifyWithSizeGuard(payload);
}

// Truncate `str` to at most `maxBytes` UTF-8 bytes, returning the
// truncated-safe string and a flag indicating whether truncation occurred.
// Truncation lands on a valid UTF-8 code-point boundary — we never emit a
// string that ends mid multi-byte sequence.
export function truncateUtf8(str: string, maxBytes: number): ToolPayloadAttributes {
  const byteLength = Buffer.byteLength(str, "utf8");
  if (byteLength <= maxBytes) {
    return { value: str, truncated: false };
  }
  const buf = Buffer.from(str, "utf8");
  let end = maxBytes;
  // UTF-8 continuation bytes start with bits `10xxxxxx` (0x80..0xBF). Walk
  // back to the start of the partial code point so we don't emit a
  // mid-sequence byte.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return { value: buf.subarray(0, end).toString("utf8"), truncated: true };
}

// ---- helpers (bottom per project convention) --------------------------------

// `JSON.stringify` with a replacer that aborts once the accumulated size
// exceeds `TOOL_PAYLOAD_RAW_MAX_BYTES`. This is an approximation — the
// replacer sees each value as it is visited, so we cannot perfectly track
// the final serialized length — but it catches the worst case (a single
// enormous string / deeply nested payload) without materializing the full
// result first.
function stringifyWithSizeGuard(payload: unknown): string {
  let running = 0;
  try {
    const encoded = JSON.stringify(payload, (key, value) => {
      // Count both the key (object property names can be arbitrarily huge —
      // e.g. `{ ["x".repeat(2*1024*1024)]: null }`) and the value. This is
      // an approximation of the final JSON byte size; it ignores JSON
      // punctuation overhead but is enough to catch payloads that would
      // OOM `JSON.stringify`.
      if (typeof key === "string") {
        running += Buffer.byteLength(key, "utf8");
      }
      if (typeof value === "string") {
        running += Buffer.byteLength(value, "utf8");
      } else if (typeof value === "number" || typeof value === "boolean") {
        running += 8;
      }
      if (running > TOOL_PAYLOAD_RAW_MAX_BYTES) {
        throw new RawPayloadTooLargeError();
      }
      return value;
    });
    if (encoded === undefined) {
      return "[unserializable]";
    }
    return encoded;
  } catch (err) {
    if (err instanceof RawPayloadTooLargeError) {
      return buildTruncatedPlaceholder();
    }
    return "[unserializable]";
  }
}

function buildTruncatedPlaceholder(): string {
  return `[truncated: raw payload exceeds ${TOOL_PAYLOAD_RAW_MAX_BYTES} bytes]`;
}

class RawPayloadTooLargeError extends Error {
  constructor() {
    super("tool payload exceeds raw size cap");
    this.name = "RawPayloadTooLargeError";
  }
}
