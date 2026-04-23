// Langfuse/OTel tracing bootstrap for the openclaw gateway.
//
// Soft-disables when LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are missing, so
// developers running the gateway without tracing keys see no behavioral
// change. When enabled, boots NodeSDK with `LangfuseSpanProcessor`, a W3C
// `traceparent` propagator, and `AsyncHooksContextManager` — the combination
// needed for the HTTP handler to extract the incoming relay trace context and
// emit its own spans as children.
//
// Call `initLangfuseTracing()` once, as early in gateway startup as possible.
// Subsequent calls are no-ops.

import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { logWarn } from "../logger.js";

let sdk: NodeSDK | null = null;
let enabled = false;

export function initLangfuseTracing(): void {
  if (sdk) {
    return;
  }

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com";

  if (!publicKey || !secretKey) {
    return;
  }

  try {
    sdk = new NodeSDK({
      // Name this service so Langfuse can distinguish its spans from those
      // emitted by the voiceclaw relay in the same unified trace.
      serviceName: process.env.OTEL_SERVICE_NAME ?? "openclaw-gateway",
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey,
          secretKey,
          baseUrl,
          environment: process.env.NODE_ENV ?? "development",
        }),
      ],
    });
    sdk.start();
    enabled = true;
  } catch (err) {
    logWarn(`langfuse tracing init failed: ${(err as Error).message}`);
    sdk = null;
    enabled = false;
  }
}

export function isLangfuseTracingEnabled(): boolean {
  return enabled;
}

export async function shutdownLangfuseTracing(): Promise<void> {
  if (!sdk) {
    return;
  }
  try {
    await sdk.shutdown();
  } catch (err) {
    logWarn(`langfuse tracing shutdown failed: ${(err as Error).message}`);
  }
}
