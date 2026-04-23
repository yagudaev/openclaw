// Tracing bootstrap for the openclaw gateway.
//
// Emits OTel spans to whichever backends are configured. Each backend is
// independently toggled by env vars — any combination works, including
// "none" (silent, zero network).
//
//   Langfuse         — LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY (+ optional
//                      LANGFUSE_BASE_URL). Uses the Langfuse span processor
//                      from @langfuse/otel, which handles media attachment
//                      and Langfuse-specific attribute mapping.
//
//   Tracing-UI       — TRACING_UI_COLLECTOR_URL (e.g.
//   collector          `http://localhost:4318/v1/traces`). Writes to our own
//                      OTLP-HTTP collector that backs the tracing UI. Fans
//                      out separately from Langfuse so one backend outage
//                      doesn't starve the other.
//
// Both exporters sit behind a BatchSpanProcessor to keep request latency
// unaffected by export latency. Request flushes happen on process shutdown.
//
// Call `initLangfuseTracing()` once, as early in gateway startup as
// possible. Subsequent calls are no-ops.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { logWarn } from "../logger.js";

let sdk: NodeSDK | null = null;
let enabled = false;

// Match the rest of openclaw's "runtime state lives under ~/.openclaw/"
// convention: look for `~/.openclaw/.env` and load it into process.env before
// we read tracing env vars. Existing environment wins so shell exports still
// override file values.
function loadOpenClawDotenv(): void {
  const path = join(homedir(), ".openclaw", ".env");
  if (!existsSync(path)) {
    return;
  }
  const loader = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof loader !== "function") {
    return;
  }
  try {
    loader.call(process, path);
  } catch (err) {
    logWarn(`tracing: failed to load ${path}: ${(err as Error).message}`);
  }
}

export function initLangfuseTracing(): void {
  if (sdk) {
    return;
  }

  loadOpenClawDotenv();

  const processors = buildSpanProcessors();
  if (processors.length === 0) {
    return;
  }

  try {
    sdk = new NodeSDK({
      // Name this service so Langfuse (and the tracing UI) can distinguish
      // its spans from those emitted by voiceclaw-relay in the same unified
      // trace.
      serviceName: process.env.OTEL_SERVICE_NAME ?? "openclaw-gateway",
      spanProcessors: processors,
    });
    sdk.start();
    enabled = true;
  } catch (err) {
    logWarn(`tracing init failed: ${(err as Error).message}`);
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
    logWarn(`tracing shutdown failed: ${(err as Error).message}`);
  }
}

function buildSpanProcessors(): SpanProcessor[] {
  const processors: SpanProcessor[] = [];
  const lfProcessor = tryBuildLangfuseProcessor();
  if (lfProcessor) {
    processors.push(lfProcessor);
  }
  const collectorProcessor = tryBuildCollectorProcessor();
  if (collectorProcessor) {
    processors.push(collectorProcessor);
  }
  return processors;
}

function tryBuildLangfuseProcessor(): SpanProcessor | null {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com";
  if (!publicKey || !secretKey) {
    return null;
  }
  return new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
    environment: process.env.NODE_ENV ?? "development",
  });
}

function tryBuildCollectorProcessor(): SpanProcessor | null {
  const url = process.env.TRACING_UI_COLLECTOR_URL?.trim();
  if (!url) {
    return null;
  }
  try {
    const exporter = new OTLPTraceExporter({ url });
    return new BatchSpanProcessor(exporter);
  } catch (err) {
    logWarn(`tracing: failed to init collector exporter at ${url}: ${(err as Error).message}`);
    return null;
  }
}
