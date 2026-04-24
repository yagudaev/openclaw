import { afterEach, describe, expect, test } from "vitest";
import {
  TOOL_PAYLOAD_MAX_BYTES,
  TOOL_PAYLOAD_RAW_MAX_BYTES,
} from "../gateway/openai-http.tool-payload.js";
import { buildToolStreamData } from "./pi-embedded-subscribe.handlers.tools.js";

describe("buildToolStreamData", () => {
  const originalCapture = process.env.OTEL_GENAI_CAPTURE_CONTENT;
  const originalLegacy = process.env.LANGFUSE_TRACE_CONTENT;

  afterEach(() => {
    restoreEnv("OTEL_GENAI_CAPTURE_CONTENT", originalCapture);
    restoreEnv("LANGFUSE_TRACE_CONTENT", originalLegacy);
  });

  test.each([
    { field: "args" as const, value: { path: "secret.txt" } },
    { field: "partialResult" as const, value: { content: [{ text: "partial secret" }] } },
    { field: "result" as const, value: { content: [{ text: "result secret" }] } },
  ])("omits $field content when capture is disabled", ({ field, value }) => {
    delete process.env.OTEL_GENAI_CAPTURE_CONTENT;
    delete process.env.LANGFUSE_TRACE_CONTENT;

    const data = buildToolStreamData(
      { phase: "start", name: "read", toolCallId: "call-1" },
      { field, value },
    );

    expect(data).toEqual({ phase: "start", name: "read", toolCallId: "call-1" });
  });

  test.each([
    { field: "args" as const, value: { path: "secret.txt" } },
    { field: "partialResult" as const, value: { content: [{ text: "partial secret" }] } },
    { field: "result" as const, value: { content: [{ text: "result secret" }] } },
  ])(
    "keeps bounded $field content in its original shape when capture is enabled",
    ({ field, value }) => {
      process.env.OTEL_GENAI_CAPTURE_CONTENT = "1";

      const data = buildToolStreamData(
        { phase: "start", name: "read", toolCallId: "call-1" },
        { field, value },
      );

      expect(data[field]).toEqual(value);
      expect(data[`${field}Truncated`]).toBeUndefined();
    },
  );

  test("truncates enabled stream content at the shared UTF-8 byte limit", () => {
    process.env.OTEL_GENAI_CAPTURE_CONTENT = "1";

    const data = buildToolStreamData(
      { phase: "result", name: "exec", toolCallId: "call-2" },
      { field: "result", value: "👍".repeat(TOOL_PAYLOAD_MAX_BYTES) },
    );

    expect(Buffer.byteLength(String(data.result), "utf8")).toBeLessThanOrEqual(
      TOOL_PAYLOAD_MAX_BYTES,
    );
    expect(data.resultTruncated).toBe(true);
  });

  test("uses the shared raw-size guard for huge enabled stream content", () => {
    process.env.OTEL_GENAI_CAPTURE_CONTENT = "1";

    const data = buildToolStreamData(
      { phase: "start", name: "write", toolCallId: "call-3" },
      { field: "args", value: "x".repeat(TOOL_PAYLOAD_RAW_MAX_BYTES + 1) },
    );

    expect(data.args).toBe(`[truncated: raw payload exceeds ${TOOL_PAYLOAD_RAW_MAX_BYTES} bytes]`);
    expect(data.argsTruncated).toBe(true);
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
