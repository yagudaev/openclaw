---
title: "Langfuse tracing"
description: "OpenTelemetry spans for the OpenAI-compatible HTTP surface, exported to Langfuse with cross-service trace-context propagation."
---

OpenClaw's gateway can emit OpenTelemetry spans for every `POST /v1/chat/completions` request and ship them to [Langfuse](https://langfuse.com/) for observability. Spans are emitted through the standard [`LangfuseSpanProcessor`](https://langfuse.com/docs/opentelemetry), so any Langfuse-compatible dashboard or alert works out of the box.

The tracer also extracts the W3C `traceparent` header from incoming requests. A caller that starts its own OpenTelemetry span before the request (for example, the [VoiceClaw](https://voiceclaw.app) relay wrapping `ask_brain` in a tool span) will see the OpenClaw spans appear as children of its own span in the same trace, producing one end-to-end view instead of two disconnected ones.

## Enabling

Set three environment variables before starting the gateway:

```
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://us.cloud.langfuse.com
```

Missing keys soft-disable tracing. The gateway still runs, no spans are emitted, no network calls are made to Langfuse.

Optional: `OTEL_SERVICE_NAME=openclaw-gateway` (the default). Override when running multiple gateways against the same Langfuse project so you can filter by service in the Langfuse UI.

## What you'll see

Every `/v1/chat/completions` request emits two observations:

- **`openclaw.chat_completions`** — a root span covering the full request lifecycle. Attributes: `http.method`, `http.route`, `gen_ai.request.model`, `openclaw.gateway.stream` (whether the caller requested streaming).
- **`openclaw.llm`** — a nested generation span around the actual agent invocation. Attributes: `langfuse.observation.model.name`, `gen_ai.request.model`, `openclaw.run_id`, plus usage details (`input`, `output`, `total` tokens) and the rendered assistant output.

If the caller provided a `traceparent` header, both spans become children of whatever span the caller was in. Otherwise, `openclaw.chat_completions` becomes a trace root.

## Verifying

With tracing enabled, POST to `/v1/chat/completions` with a synthetic `traceparent`:

```bash
TRACE_ID=$(openssl rand -hex 16)
SPAN_ID=$(openssl rand -hex 8)
curl -X POST http://localhost:18789/v1/chat/completions \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -H "traceparent: 00-$TRACE_ID-$SPAN_ID-01" \
  -d '{"model":"openclaw","messages":[{"role":"user","content":"say pong"}]}'
```

Query the Langfuse REST API a few seconds later:

```bash
curl -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  "$LANGFUSE_BASE_URL/api/public/traces/$TRACE_ID"
```

The response should contain two observations with `service.name=openclaw-gateway` under the trace id you provided.

## Debugging

- **No spans in Langfuse.** Check gateway stdout for the absence of errors during the first few seconds after boot. Keys missing produces no log — use the `OTEL_LOG_LEVEL=debug` env var if you want verbose OTel diagnostics.
- **Spans export, but unified trace never forms.** The caller either isn't sending `traceparent` or is sending an invalid value. Confirm the exact header with `curl -v` or a reverse proxy log.
- **`openclaw.llm` missing `output` attribute.** The agent call errored before producing a result. Check for a recorded exception on the span — the gateway emits `SpanStatusCode.ERROR` with the error message.
