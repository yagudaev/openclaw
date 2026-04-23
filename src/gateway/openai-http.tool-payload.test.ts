import { describe, expect, test } from "vitest";
import {
  TOOL_PAYLOAD_MAX_BYTES,
  TOOL_PAYLOAD_RAW_MAX_BYTES,
  buildToolPayloadAttribute,
  serializeToolPayload,
  truncateUtf8,
} from "./openai-http.tool-payload.js";

describe("truncateUtf8", () => {
  test("passes short ASCII through unchanged", () => {
    const res = truncateUtf8("hello", 64);
    expect(res).toEqual({ value: "hello", truncated: false });
  });

  test("truncates ASCII by byte count", () => {
    const res = truncateUtf8("abcdefgh", 4);
    expect(res).toEqual({ value: "abcd", truncated: true });
  });

  test("lands on valid UTF-8 boundary with multi-byte code points", () => {
    // "é" is 2 bytes (c3 a9). With maxBytes=3 the naive `.slice(0,3)` on
    // UTF-16 code units would emit 3 characters (6 bytes). Byte-aware must
    // emit "é" (2 bytes) and flag truncated.
    const res = truncateUtf8("ééé", 3);
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.value, "utf8")).toBeLessThanOrEqual(3);
    expect(res.value).toBe("é");
  });

  test("never emits mid-sequence bytes for emoji", () => {
    // Each emoji here is 4 UTF-8 bytes. maxBytes=6 must not split the second
    // emoji — we should get exactly one emoji.
    const res = truncateUtf8("👍👍👍", 6);
    expect(res.truncated).toBe(true);
    expect(res.value).toBe("👍");
    expect(Buffer.byteLength(res.value, "utf8")).toBe(4);
  });

  test("UTF-16 slice footgun: intent is 64KiB, bytes stay <= 64KiB", () => {
    // 16384 emoji × 4 bytes = 65536 bytes.  Each emoji is ONE UTF-16
    // surrogate pair (two code units). Naive `.slice(0, 65536)` on UTF-16
    // would pass all 16384 emoji through (= 65536 UTF-8 bytes) — still at
    // the limit. Add one more: at 65540 bytes we expect exactly 64 KiB of
    // bytes out.
    const payload = "👍".repeat(16400);
    const res = truncateUtf8(payload, 64 * 1024);
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.value, "utf8")).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("serializeToolPayload", () => {
  test("passes strings through", () => {
    expect(serializeToolPayload("hello")).toBe("hello");
  });

  test("stringifies objects with JSON", () => {
    expect(serializeToolPayload({ a: 1 })).toBe('{"a":1}');
  });

  test("handles circular references without throwing", () => {
    const obj: Record<string, unknown> = { name: "x" };
    obj.self = obj;
    expect(serializeToolPayload(obj)).toBe("[unserializable]");
  });

  test("returns undefined for null/undefined", () => {
    expect(serializeToolPayload(null)).toBeUndefined();
    expect(serializeToolPayload(undefined)).toBeUndefined();
  });

  test("stringifies primitives", () => {
    expect(serializeToolPayload(42)).toBe("42");
    expect(serializeToolPayload(true)).toBe("true");
  });

  test("size-guards huge strings before JSON.stringify", () => {
    // 2 MiB string — well over the 1 MiB raw cap. Must NOT allocate the
    // full serialized payload; must return a placeholder. We can't easily
    // assert allocation, but we assert the output is the placeholder
    // sentinel (cheap) and not the full 2 MiB string.
    const huge = "x".repeat(2 * 1024 * 1024);
    const out = serializeToolPayload(huge);
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThan(200);
    expect(out).toMatch(/^\[truncated:/);
  });

  test("size-guards huge object payloads before stringify", () => {
    // Build an object with a ~2 MiB string inside. The replacer should
    // abort before producing the full JSON encoding.
    const huge = { data: "y".repeat(2 * 1024 * 1024) };
    const out = serializeToolPayload(huge);
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThan(200);
    expect(out).toMatch(/^\[truncated:/);
  });

  test("size-guards huge Buffer payloads before JSON.stringify", () => {
    // Node Buffer.toJSON() expands a Buffer into { type, data: [...] }
    // where each byte becomes an integer in the array — the serialized
    // form is ~6 bytes per source byte. A 2 MiB buffer would allocate
    // multiple MiB under JSON.stringify. Upfront byte-size guard must
    // reject before serialization.
    const huge = Buffer.alloc(2 * 1024 * 1024);
    const out = serializeToolPayload(huge);
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThan(200);
    expect(out).toMatch(/^\[truncated:/);
  });

  test("size-guards huge typed-array payloads before JSON.stringify", () => {
    const huge = new Uint8Array(2 * 1024 * 1024);
    const out = serializeToolPayload(huge);
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThan(200);
    expect(out).toMatch(/^\[truncated:/);
  });

  test("size-guards payloads with huge object keys", () => {
    // Key strings can also be arbitrarily large. A 2 MiB key must trip the
    // guard even though the value is tiny — otherwise a malicious caller
    // could bypass the budget by encoding their data into a JSON key.
    const hugeKey = "k".repeat(2 * 1024 * 1024);
    const out = serializeToolPayload({ [hugeKey]: null });
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThan(200);
    expect(out).toMatch(/^\[truncated:/);
  });

  test("passes raw payloads just under the cap", () => {
    // 512 KiB string — under the 1 MiB raw cap but over the 64 KiB attr
    // cap. `serializeToolPayload` returns the full string; truncation
    // happens downstream in `buildToolPayloadAttribute`.
    const medium = "z".repeat(512 * 1024);
    const out = serializeToolPayload(medium);
    expect(out).toBe(medium);
  });
});

describe("buildToolPayloadAttribute", () => {
  test("returns undefined for null/undefined", () => {
    expect(buildToolPayloadAttribute(null)).toBeUndefined();
    expect(buildToolPayloadAttribute(undefined)).toBeUndefined();
  });

  test("short payload: not truncated", () => {
    const res = buildToolPayloadAttribute("hello");
    expect(res).toEqual({ value: "hello", truncated: false });
  });

  test("64 KiB + 1 byte: truncated at byte boundary", () => {
    const str = "a".repeat(TOOL_PAYLOAD_MAX_BYTES + 1);
    const res = buildToolPayloadAttribute(str);
    expect(res?.truncated).toBe(true);
    expect(Buffer.byteLength(res!.value, "utf8")).toBeLessThanOrEqual(TOOL_PAYLOAD_MAX_BYTES);
  });

  test("huge raw payload becomes placeholder (not allocated-then-truncated)", () => {
    const huge = "h".repeat(TOOL_PAYLOAD_RAW_MAX_BYTES * 2);
    const res = buildToolPayloadAttribute(huge);
    expect(res).toBeDefined();
    expect(res!.truncated).toBe(false);
    expect(res!.value).toMatch(/^\[truncated:/);
  });

  test("multi-byte payload truncated to 64 KiB stays at valid UTF-8 boundary", () => {
    // 20000 emoji × 4 bytes = 80000 bytes, over 64 KiB.
    const payload = "🚀".repeat(20000);
    const res = buildToolPayloadAttribute(payload);
    expect(res?.truncated).toBe(true);
    const bytes = Buffer.byteLength(res!.value, "utf8");
    expect(bytes).toBeLessThanOrEqual(TOOL_PAYLOAD_MAX_BYTES);
    // Decoded value must not have a U+FFFD replacement char at the tail.
    expect(res!.value).not.toMatch(/�$/);
  });
});
