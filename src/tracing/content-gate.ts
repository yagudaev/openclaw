// Vendor-neutral gate for exporting content-bearing OTel span attributes.
//
// Prompts, assistant outputs, and tool input/output can contain PII, secrets,
// or large blobs. The gate suppresses content-bearing attributes by default;
// structural metadata (model, usage, http.*, trace structure) always flows.
//
// The gate guards raw OTel span attrs, not a Langfuse-specific surface — the
// same span stream fans out to Langfuse, a self-hosted OTLP collector, or any
// other backend. Hence the vendor-neutral name.
//
// Env vars (read in order of preference):
//   OTEL_GENAI_CAPTURE_CONTENT=1   primary; follows the OTel GenAI semantic-
//                                  convention env-var shape (the spec name is
//                                  `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`;
//                                  the shorter form is common in the ecosystem).
//   LANGFUSE_TRACE_CONTENT=1       deprecated fallback; kept so existing
//                                  deployments keep working until they rotate
//                                  env. Prefer the new name when both are set.
//
// Truthy value is exactly "1" (matching prior `LANGFUSE_TRACE_CONTENT === "1"`
// semantics — anything else, including "true" or "yes", is treated as off).

export function isContentCaptureEnabled(): boolean {
  const primary = process.env.OTEL_GENAI_CAPTURE_CONTENT;
  const legacy = process.env.LANGFUSE_TRACE_CONTENT;
  const val = primary ?? legacy;
  return val === "1";
}
