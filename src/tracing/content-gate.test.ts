import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isContentCaptureEnabled } from "./content-gate.js";

describe("isContentCaptureEnabled", () => {
  const originalPrimary = process.env.OTEL_GENAI_CAPTURE_CONTENT;
  const originalLegacy = process.env.LANGFUSE_TRACE_CONTENT;

  beforeEach(() => {
    delete process.env.OTEL_GENAI_CAPTURE_CONTENT;
    delete process.env.LANGFUSE_TRACE_CONTENT;
  });

  afterEach(() => {
    restoreEnv("OTEL_GENAI_CAPTURE_CONTENT", originalPrimary);
    restoreEnv("LANGFUSE_TRACE_CONTENT", originalLegacy);
  });

  it("is off by default when neither var is set", () => {
    expect(isContentCaptureEnabled()).toBe(false);
  });

  it("is on when OTEL_GENAI_CAPTURE_CONTENT='1'", () => {
    process.env.OTEL_GENAI_CAPTURE_CONTENT = "1";
    expect(isContentCaptureEnabled()).toBe(true);
  });

  it("honors the deprecated LANGFUSE_TRACE_CONTENT fallback when primary is unset", () => {
    process.env.LANGFUSE_TRACE_CONTENT = "1";
    expect(isContentCaptureEnabled()).toBe(true);
  });

  it("prefers the primary var when both are set", () => {
    // Primary off wins over legacy on — deployments moving to the new var
    // should not be silently overridden by stale legacy env.
    process.env.OTEL_GENAI_CAPTURE_CONTENT = "0";
    process.env.LANGFUSE_TRACE_CONTENT = "1";
    expect(isContentCaptureEnabled()).toBe(false);

    process.env.OTEL_GENAI_CAPTURE_CONTENT = "1";
    process.env.LANGFUSE_TRACE_CONTENT = "0";
    expect(isContentCaptureEnabled()).toBe(true);
  });

  it("treats non-'1' truthy-looking values as off (strict match, prior semantics)", () => {
    for (const v of ["true", "yes", "on", "2", " 1"]) {
      process.env.OTEL_GENAI_CAPTURE_CONTENT = v;
      expect(isContentCaptureEnabled()).toBe(false);
    }
    delete process.env.OTEL_GENAI_CAPTURE_CONTENT;
    for (const v of ["true", "yes", "on", "2", " 1"]) {
      process.env.LANGFUSE_TRACE_CONTENT = v;
      expect(isContentCaptureEnabled()).toBe(false);
    }
  });
});

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}
