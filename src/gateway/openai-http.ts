import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
} from "@opentelemetry/api";
import type { ImageContent } from "../agents/command/types.js";
import { normalizeUsage, toOpenAiChatCompletionsUsage } from "../agents/usage.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import type { GatewayHttpChatCompletionsConfig } from "../config/types.gateway.js";
import { emitAgentEvent, onAgentEvent, type AgentItemEventData } from "../infra/agent-events.js";
import { logWarn } from "../logger.js";
import { estimateBase64DecodedBytes } from "../media/base64.js";
import {
  DEFAULT_INPUT_IMAGE_MAX_BYTES,
  DEFAULT_INPUT_IMAGE_MIMES,
  DEFAULT_INPUT_MAX_REDIRECTS,
  DEFAULT_INPUT_TIMEOUT_MS,
  extractImageContentFromSource,
  normalizeMimeList,
  type InputImageLimits,
  type InputImageSource,
} from "../media/input-files.js";
import { defaultRuntime } from "../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveAssistantStreamDeltaText } from "./agent-event-assistant-text.js";
import {
  buildAgentMessageFromConversationEntries,
  type ConversationEntry,
} from "./agent-prompt.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson, setSseHeaders, watchClientDisconnect, writeDone } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import {
  resolveGatewayRequestContext,
  resolveOpenAiCompatModelOverride,
  resolveOpenAiCompatibleHttpOperatorScopes,
  resolveOpenAiCompatibleHttpSenderIsOwner,
  type AuthorizedGatewayHttpRequest,
} from "./http-utils.js";
import { normalizeInputHostnameAllowlist } from "./input-allowlist.js";

type OpenAiHttpOptions = {
  auth: ResolvedGatewayAuth;
  config?: GatewayHttpChatCompletionsConfig;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type OpenAiChatMessage = {
  role?: unknown;
  content?: unknown;
  name?: unknown;
};

type OpenAiChatCompletionRequest = {
  model?: unknown;
  stream?: unknown;
  // Naming/style reference: src/agents/openai-transport-stream.ts:1262-1273
  stream_options?: unknown;
  messages?: unknown;
  user?: unknown;
};

const DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES = 20 * 1024 * 1024;
const IMAGE_ONLY_USER_MESSAGE = "User sent image(s) with no text.";
const DEFAULT_OPENAI_MAX_IMAGE_PARTS = 8;
const DEFAULT_OPENAI_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_OPENAI_IMAGE_LIMITS: InputImageLimits = {
  allowUrl: false,
  allowedMimes: new Set(DEFAULT_INPUT_IMAGE_MIMES),
  maxBytes: DEFAULT_INPUT_IMAGE_MAX_BYTES,
  maxRedirects: DEFAULT_INPUT_MAX_REDIRECTS,
  timeoutMs: DEFAULT_INPUT_TIMEOUT_MS,
};

type ResolvedOpenAiChatCompletionsLimits = {
  maxBodyBytes: number;
  maxImageParts: number;
  maxTotalImageBytes: number;
  images: InputImageLimits;
};

function resolveOpenAiChatCompletionsLimits(
  config: GatewayHttpChatCompletionsConfig | undefined,
): ResolvedOpenAiChatCompletionsLimits {
  const imageConfig = config?.images;
  return {
    maxBodyBytes: config?.maxBodyBytes ?? DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES,
    maxImageParts:
      typeof config?.maxImageParts === "number"
        ? Math.max(0, Math.floor(config.maxImageParts))
        : DEFAULT_OPENAI_MAX_IMAGE_PARTS,
    maxTotalImageBytes:
      typeof config?.maxTotalImageBytes === "number"
        ? Math.max(1, Math.floor(config.maxTotalImageBytes))
        : DEFAULT_OPENAI_MAX_TOTAL_IMAGE_BYTES,
    images: {
      allowUrl: imageConfig?.allowUrl ?? DEFAULT_OPENAI_IMAGE_LIMITS.allowUrl,
      urlAllowlist: normalizeInputHostnameAllowlist(imageConfig?.urlAllowlist),
      allowedMimes: normalizeMimeList(imageConfig?.allowedMimes, DEFAULT_INPUT_IMAGE_MIMES),
      maxBytes: imageConfig?.maxBytes ?? DEFAULT_INPUT_IMAGE_MAX_BYTES,
      maxRedirects: imageConfig?.maxRedirects ?? DEFAULT_INPUT_MAX_REDIRECTS,
      timeoutMs: imageConfig?.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS,
    },
  };
}

function writeSse(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function buildAgentCommandInput(params: {
  prompt: { message: string; extraSystemPrompt?: string; images?: ImageContent[] };
  modelOverride?: string;
  sessionKey: string;
  runId: string;
  messageChannel: string;
  senderIsOwner: boolean;
  abortSignal?: AbortSignal;
}) {
  return {
    message: params.prompt.message,
    extraSystemPrompt: params.prompt.extraSystemPrompt,
    images: params.prompt.images,
    model: params.modelOverride,
    sessionKey: params.sessionKey,
    runId: params.runId,
    deliver: false as const,
    messageChannel: params.messageChannel,
    bestEffortDeliver: false as const,
    senderIsOwner: params.senderIsOwner,
    allowModelOverride: true as const,
    abortSignal: params.abortSignal,
  };
}

function writeAssistantRoleChunk(res: ServerResponse, params: { runId: string; model: string }) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [{ index: 0, delta: { role: "assistant" } }],
  });
}

function writeAssistantContentChunk(
  res: ServerResponse,
  params: { runId: string; model: string; content: string; finishReason: "stop" | null },
) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        delta: { content: params.content },
        finish_reason: params.finishReason,
      },
    ],
  });
}

function writeAssistantStopChunk(res: ServerResponse, params: { runId: string; model: string }) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  });
}

function writeUsageChunk(
  res: ServerResponse,
  params: {
    runId: string;
    model: string;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  },
) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [],
    usage: params.usage,
  });
}

function asMessages(val: unknown): OpenAiChatMessage[] {
  return Array.isArray(val) ? (val as OpenAiChatMessage[]) : [];
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }
        const type = (part as { type?: unknown }).type;
        const text = (part as { text?: unknown }).text;
        const inputText = (part as { input_text?: unknown }).input_text;
        if (type === "text" && typeof text === "string") {
          return text;
        }
        if (type === "input_text" && typeof text === "string") {
          return text;
        }
        if (typeof inputText === "string") {
          return inputText;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function resolveImageUrlPart(part: unknown): string | undefined {
  if (!part || typeof part !== "object") {
    return undefined;
  }
  const imageUrl = (part as { image_url?: unknown }).image_url;
  if (typeof imageUrl === "string") {
    const trimmed = imageUrl.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!imageUrl || typeof imageUrl !== "object") {
    return undefined;
  }
  const rawUrl = (imageUrl as { url?: unknown }).url;
  if (typeof rawUrl !== "string") {
    return undefined;
  }
  const trimmed = rawUrl.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractImageUrls(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const urls: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    if ((part as { type?: unknown }).type !== "image_url") {
      continue;
    }
    const url = resolveImageUrlPart(part);
    if (url) {
      urls.push(url);
    }
  }
  return urls;
}

type ActiveTurnContext = {
  activeTurnIndex: number;
  activeUserMessageIndex: number;
  urls: string[];
};

function parseImageUrlToSource(url: string): InputImageSource {
  const dataUriMatch = /^data:([^,]*?),(.*)$/is.exec(url);
  if (dataUriMatch) {
    const metadata = normalizeOptionalString(dataUriMatch[1]) ?? "";
    const data = dataUriMatch[2] ?? "";
    const metadataParts = metadata
      .split(";")
      .map((part) => normalizeOptionalString(part) ?? "")
      .filter(Boolean);
    const isBase64 = metadataParts.some(
      (part) => normalizeLowercaseStringOrEmpty(part) === "base64",
    );
    if (!isBase64) {
      throw new Error("image_url data URI must be base64 encoded");
    }
    if (!(normalizeOptionalString(data) ?? "")) {
      throw new Error("image_url data URI is missing payload data");
    }
    const mediaTypeRaw = metadataParts.find((part) => part.includes("/"));
    return {
      type: "base64",
      mediaType: mediaTypeRaw,
      data,
    };
  }
  return { type: "url", url };
}

function resolveActiveTurnContext(messagesUnknown: unknown): ActiveTurnContext {
  const messages = asMessages(messagesUnknown);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = normalizeOptionalString(msg.role) ?? "";
    const normalizedRole = role === "function" ? "tool" : role;
    if (normalizedRole !== "user" && normalizedRole !== "tool") {
      continue;
    }
    return {
      activeTurnIndex: i,
      activeUserMessageIndex: normalizedRole === "user" ? i : -1,
      urls: normalizedRole === "user" ? extractImageUrls(msg.content) : [],
    };
  }
  return { activeTurnIndex: -1, activeUserMessageIndex: -1, urls: [] };
}

async function resolveImagesForRequest(
  activeTurnContext: Pick<ActiveTurnContext, "urls">,
  limits: ResolvedOpenAiChatCompletionsLimits,
): Promise<ImageContent[]> {
  const urls = activeTurnContext.urls;
  if (urls.length === 0) {
    return [];
  }
  if (urls.length > limits.maxImageParts) {
    throw new Error(`Too many image_url parts (${urls.length}; limit ${limits.maxImageParts})`);
  }

  const images: ImageContent[] = [];
  let totalBytes = 0;
  for (const url of urls) {
    const source = parseImageUrlToSource(url);
    if (source.type === "base64") {
      const sourceBytes = estimateBase64DecodedBytes(source.data);
      if (totalBytes + sourceBytes > limits.maxTotalImageBytes) {
        throw new Error(
          `Total image payload too large (${totalBytes + sourceBytes}; limit ${limits.maxTotalImageBytes})`,
        );
      }
    }

    const image = await extractImageContentFromSource(source, limits.images);
    totalBytes += estimateBase64DecodedBytes(image.data);
    if (totalBytes > limits.maxTotalImageBytes) {
      throw new Error(
        `Total image payload too large (${totalBytes}; limit ${limits.maxTotalImageBytes})`,
      );
    }
    images.push(image);
  }
  return images;
}

export const __testOnlyOpenAiHttp = {
  resolveImagesForRequest,
  resolveOpenAiChatCompletionsLimits,
};

function buildAgentPrompt(
  messagesUnknown: unknown,
  activeUserMessageIndex: number,
): {
  message: string;
  extraSystemPrompt?: string;
} {
  const messages = asMessages(messagesUnknown);

  const systemParts: string[] = [];
  const conversationEntries: ConversationEntry[] = [];

  for (const [i, msg] of messages.entries()) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = normalizeOptionalString(msg.role) ?? "";
    const content = extractTextContent(msg.content).trim();
    const hasImage = extractImageUrls(msg.content).length > 0;
    if (!role) {
      continue;
    }
    if (role === "system" || role === "developer") {
      if (content) {
        systemParts.push(content);
      }
      continue;
    }

    const normalizedRole = role === "function" ? "tool" : role;
    if (normalizedRole !== "user" && normalizedRole !== "assistant" && normalizedRole !== "tool") {
      continue;
    }

    // Keep the image-only placeholder scoped to the active user turn so we don't
    // mention historical image-only turns whose bytes are intentionally not replayed.
    const messageContent =
      normalizedRole === "user" && !content && hasImage && i === activeUserMessageIndex
        ? IMAGE_ONLY_USER_MESSAGE
        : content;
    if (!messageContent) {
      continue;
    }

    const name = normalizeOptionalString(msg.name) ?? "";
    const sender =
      normalizedRole === "assistant"
        ? "Assistant"
        : normalizedRole === "user"
          ? "User"
          : name
            ? `Tool:${name}`
            : "Tool";

    conversationEntries.push({
      role: normalizedRole,
      entry: { sender, body: messageContent },
    });
  }

  const message = buildAgentMessageFromConversationEntries(conversationEntries);

  return {
    message,
    extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

function coerceRequest(val: unknown): OpenAiChatCompletionRequest {
  if (!val || typeof val !== "object") {
    return {};
  }
  return val as OpenAiChatCompletionRequest;
}

function resolveAgentResponseText(result: unknown): string {
  const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return "No response from OpenClaw.";
  }
  const content = payloads
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n\n");
  return content || "No response from OpenClaw.";
}

type AgentUsageMeta = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

function resolveRawAgentUsage(result: unknown): AgentUsageMeta | undefined {
  return (
    result as {
      meta?: {
        agentMeta?: {
          usage?: AgentUsageMeta;
        };
      };
    } | null
  )?.meta?.agentMeta?.usage;
}

function resolveChatCompletionUsage(result: unknown): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  return toOpenAiChatCompletionsUsage(normalizeUsage(resolveRawAgentUsage(result)));
}

function resolveIncludeUsageForStreaming(payload: OpenAiChatCompletionRequest): boolean {
  // Keep parsing aligned with OpenAI wire-format field names.
  // Flow reference: src/agents/openai-transport-stream.ts:1262-1273
  const streamOptions = payload.stream_options;
  if (!streamOptions || typeof streamOptions !== "object" || Array.isArray(streamOptions)) {
    return false;
  }
  return (streamOptions as { include_usage?: unknown }).include_usage === true;
}

const openaiCompatTracer = trace.getTracer("openclaw-gateway/openai-http");

// Opt-in full-content export. Prompts + assistant outputs can contain PII or
// secrets; gate content-bearing attributes behind an explicit flag rather than
// sending everything to Langfuse by default.
function isTraceContentEnabled(): boolean {
  return process.env.LANGFUSE_TRACE_CONTENT === "1";
}

export async function handleOpenAiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiHttpOptions,
): Promise<boolean> {
  const limits = resolveOpenAiChatCompletionsLimits(opts.config);
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/chat/completions",
    requiredOperatorMethod: "chat.send",
    // Compat HTTP uses a different scope model from generic HTTP helpers:
    // shared-secret bearer auth is treated as full operator access here.
    resolveOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopes,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: opts.maxBodyBytes ?? limits.maxBodyBytes,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    // Auth/body failure — helper already sent the error response. Skip tracing
    // to avoid attaching a no-op span to an incoming `traceparent` for a
    // request that never reached our handler.
    return true;
  }

  // Now we know this is a real chat_completions request for us — open the
  // root span. Extract W3C trace context from the incoming request so callers
  // that already trace (e.g. the voiceclaw relay's ask_brain tool span) see
  // our spans as children.
  const parentCtx = propagation.extract(context.active(), req.headers);
  const rootSpan = openaiCompatTracer.startSpan(
    "openclaw.chat_completions",
    {
      kind: SpanKind.SERVER,
      attributes: {
        "http.method": "POST",
        "http.route": "/v1/chat/completions",
        "langfuse.observation.type": "SPAN",
      },
    },
    parentCtx,
  );
  const rootCtx = trace.setSpan(parentCtx, rootSpan);
  // End on `finish` so span duration reflects request time even on keep-alive
  // (where `close` fires only when the connection tears down). Also listen on
  // `close` as a safety net for client aborts mid-stream. OTel silently
  // tolerates double-end.
  res.once("finish", () => rootSpan.end());
  res.once("close", () => rootSpan.end());

  return context.with(rootCtx, () => processOpenAiHttpRequest(req, res, opts, handled, rootSpan));
}

async function processOpenAiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiHttpOptions,
  handled: { body: unknown; requestAuth: AuthorizedGatewayHttpRequest },
  rootSpan: Span,
): Promise<boolean> {
  const limits = resolveOpenAiChatCompletionsLimits(opts.config);
  // On the compat surface, shared-secret bearer auth is also treated as an
  // owner sender so owner-only tool policy matches the documented contract.
  const senderIsOwner = resolveOpenAiCompatibleHttpSenderIsOwner(req, handled.requestAuth);

  const payload = coerceRequest(handled.body);
  const stream = Boolean(payload.stream);
  const streamIncludeUsage = stream && resolveIncludeUsageForStreaming(payload);
  const model = typeof payload.model === "string" ? payload.model : "openclaw";
  const user = typeof payload.user === "string" ? payload.user : undefined;

  rootSpan.setAttributes({
    "gen_ai.request.model": model,
    "openclaw.gateway.stream": stream,
  });

  // Capture the HTTP request body as the span's input so Langfuse's Preview
  // tab shows the incoming chat payload (messages array) rather than a null.
  // The wrapping `openclaw.chat_completions` span represents the HTTP layer;
  // the LLM-specific work lives in the nested `openclaw.llm` generation.
  if (isTraceContentEnabled()) {
    const messages = asMessages(payload.messages);
    if (messages.length > 0) {
      rootSpan.setAttribute("langfuse.observation.input", JSON.stringify(messages));
    }
  }

  const { agentId, sessionKey, messageChannel } = resolveGatewayRequestContext({
    req,
    model,
    user,
    sessionPrefix: "openai",
    defaultMessageChannel: "webchat",
    useMessageChannelHeader: true,
  });
  const { modelOverride, errorMessage: modelError } = await resolveOpenAiCompatModelOverride({
    req,
    agentId,
    model,
  });
  if (modelError) {
    sendJson(res, 400, {
      error: { message: modelError, type: "invalid_request_error" },
    });
    return true;
  }
  const activeTurnContext = resolveActiveTurnContext(payload.messages);
  const prompt = buildAgentPrompt(payload.messages, activeTurnContext.activeUserMessageIndex);
  let images: ImageContent[] = [];
  try {
    images = await resolveImagesForRequest(activeTurnContext, limits);
  } catch (err) {
    logWarn(`openai-compat: invalid image_url content: ${String(err)}`);
    sendJson(res, 400, {
      error: {
        message: "Invalid image_url content in `messages`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  if (!prompt.message && images.length === 0) {
    sendJson(res, 400, {
      error: {
        message: "Missing user message in `messages`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const runId = `chatcmpl_${randomUUID()}`;
  const deps = createDefaultDeps();
  const abortController = new AbortController();
  const commandInput = buildAgentCommandInput({
    prompt: {
      message: prompt.message,
      extraSystemPrompt: prompt.extraSystemPrompt,
      images: images.length > 0 ? images : undefined,
    },
    modelOverride,
    sessionKey,
    runId,
    messageChannel,
    abortSignal: abortController.signal,
    senderIsOwner,
  });

  if (!stream) {
    const stopWatchingDisconnect = watchClientDisconnect(req, res, abortController);
    try {
      const result = await runAgentCommandWithGenerationSpan(commandInput, deps, {
        model,
        runId,
        prompt: prompt.message,
        extraSystemPrompt: prompt.extraSystemPrompt,
        requestMessages: asMessages(payload.messages),
      });

      if (abortController.signal.aborted) {
        return true;
      }

      const content = resolveAgentResponseText(result);
      const usage = resolveChatCompletionUsage(result);

      if (isTraceContentEnabled()) {
        rootSpan.setAttribute("langfuse.observation.output", content);
      }

      sendJson(res, 200, {
        id: runId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage,
      });
    } catch (err) {
      if (abortController.signal.aborted) {
        return true;
      }
      rootSpan.recordException(err as Error);
      rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      logWarn(`openai-compat: chat completion failed: ${String(err)}`);
      sendJson(res, 500, {
        error: { message: "internal error", type: "api_error" },
      });
    } finally {
      stopWatchingDisconnect();
    }
    return true;
  }

  setSseHeaders(res);

  let wroteRole = false;
  let wroteStopChunk = false;
  let sawAssistantDelta = false;
  let finalUsage:
    | {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      }
    | undefined;
  let finalizeRequested = false;
  let closed = false;
  let stopWatchingDisconnect = () => {};

  const maybeFinalize = () => {
    if (closed || !finalizeRequested) {
      return;
    }
    if (streamIncludeUsage && !finalUsage) {
      return;
    }
    closed = true;
    stopWatchingDisconnect();
    unsubscribe();
    if (!wroteStopChunk) {
      writeAssistantStopChunk(res, { runId, model });
      wroteStopChunk = true;
    }
    if (streamIncludeUsage && finalUsage) {
      writeUsageChunk(res, { runId, model, usage: finalUsage });
    }
    writeDone(res);
    res.end();
  };

  const requestFinalize = () => {
    finalizeRequested = true;
    maybeFinalize();
  };

  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== runId) {
      return;
    }
    if (closed) {
      return;
    }

    if (evt.stream === "assistant") {
      const content = resolveAssistantStreamDeltaText(evt) ?? "";
      if (!content) {
        return;
      }

      if (!wroteRole) {
        wroteRole = true;
        writeAssistantRoleChunk(res, { runId, model });
      }

      sawAssistantDelta = true;
      writeAssistantContentChunk(res, {
        runId,
        model,
        content,
        finishReason: null,
      });
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        requestFinalize();
      }
    }
  });

  stopWatchingDisconnect = watchClientDisconnect(req, res, abortController, () => {
    closed = true;
    unsubscribe();
  });

  void (async () => {
    try {
      const result = await runAgentCommandWithGenerationSpan(commandInput, deps, {
        model,
        runId,
        prompt: prompt.message,
        extraSystemPrompt: prompt.extraSystemPrompt,
        requestMessages: asMessages(payload.messages),
      });

      if (closed) {
        return;
      }

      if (isTraceContentEnabled()) {
        rootSpan.setAttributes({
          "langfuse.observation.output": resolveAgentResponseText(result),
        });
      }
      finalUsage = resolveChatCompletionUsage(result);

      if (!sawAssistantDelta) {
        if (!wroteRole) {
          wroteRole = true;
          writeAssistantRoleChunk(res, { runId, model });
        }

        const content = resolveAgentResponseText(result);

        sawAssistantDelta = true;
        writeAssistantContentChunk(res, {
          runId,
          model,
          content,
          finishReason: null,
        });
      }
      requestFinalize();
    } catch (err) {
      if (closed || abortController.signal.aborted) {
        return;
      }
      rootSpan.recordException(err as Error);
      rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      logWarn(`openai-compat: streaming chat completion failed: ${String(err)}`);
      writeAssistantContentChunk(res, {
        runId,
        model,
        content: "Error: internal error",
        finishReason: "stop",
      });
      wroteStopChunk = true;
      finalUsage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "error" },
      });
      requestFinalize();
    } finally {
      if (!closed) {
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "end" },
        });
      }
    }
  })();

  return true;
}

// Wraps `agentCommandFromIngress` in a Langfuse GENERATION span. Emits model,
// prompt, and completion attributes so the downstream trace captures the LLM
// call inside the gateway — not just the HTTP envelope. Also subscribes to the
// agent's item event stream so every tool call / command / search inside the
// agent becomes its own child span under the generation — the caller sees the
// exact work the agent did, not just the wrapper envelope.
async function runAgentCommandWithGenerationSpan(
  commandInput: Parameters<typeof agentCommandFromIngress>[0],
  deps: Parameters<typeof agentCommandFromIngress>[2],
  attrs: {
    model: string;
    runId: string;
    prompt: string | undefined;
    extraSystemPrompt?: string;
    requestMessages?: OpenAiChatMessage[];
  },
): Promise<Awaited<ReturnType<typeof agentCommandFromIngress>>> {
  const traceContent = isTraceContentEnabled();
  const generation = openaiCompatTracer.startSpan("openclaw.llm", {
    attributes: {
      "langfuse.observation.type": "GENERATION",
      "langfuse.observation.model.name": attrs.model,
      "gen_ai.request.model": attrs.model,
      "openclaw.run_id": attrs.runId,
      ...(traceContent ? buildGenerationInputAttributes(attrs) : {}),
    },
  });
  const generationCtx = trace.setSpan(context.active(), generation);
  const itemSpans = new Map<string, Span>();
  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== attrs.runId) {
      return;
    }
    if (evt.stream === "item") {
      handleItemEvent({
        data: evt.data as unknown as AgentItemEventData,
        itemSpans,
        parentCtx: generationCtx,
        traceContent,
      });
      return;
    }
    if (evt.stream === "cli_input" && traceContent) {
      // Resolved system prompt + final prompt that claude-cli actually
      // receives — captured at the cli-runner layer where the workspace
      // bootstrap (MEMORY.md, identity) has been composed into the request.
      // Promote this into `langfuse.observation.input` so it shows up in the
      // Langfuse Preview panel as a proper chat conversation, not buried in
      // metadata. The caller-side messages we captured at span-open are
      // typically just the user turn (voiceclaw's ask_brain sends only that);
      // the resolved CLI input is the interesting view.
      const data = evt.data as unknown as {
        systemPrompt?: string;
        prompt?: string;
      };
      const messages: Array<{ role: string; content: string }> = [];
      if (typeof data.systemPrompt === "string" && data.systemPrompt.length > 0) {
        messages.push({ role: "system", content: data.systemPrompt });
      }
      if (typeof data.prompt === "string" && data.prompt.length > 0) {
        messages.push({ role: "user", content: data.prompt });
      }
      if (messages.length > 0) {
        generation.setAttribute("langfuse.observation.input", JSON.stringify(messages));
      }
    }
  });
  try {
    const result = await context.with(generationCtx, () =>
      agentCommandFromIngress(commandInput, defaultRuntime, deps),
    );
    const usage = resolveChatCompletionUsage(result);
    generation.setAttributes({
      ...(traceContent ? { "langfuse.observation.output": resolveAgentResponseText(result) } : {}),
      "langfuse.observation.usage_details": JSON.stringify({
        input: usage.prompt_tokens,
        output: usage.completion_tokens,
        total: usage.total_tokens,
      }),
    });
    return result;
  } catch (err) {
    generation.recordException(err as Error);
    generation.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
    throw err;
  } finally {
    unsubscribe();
    // Close any item spans the agent forgot (or crashed before) closing. We
    // see these as WARNING in Langfuse, distinct from clean completions, so
    // missing `end` events are visible instead of hiding silently.
    for (const [itemId, span] of itemSpans) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: "item span closed without end phase",
      });
      span.end();
      itemSpans.delete(itemId);
    }
    generation.end();
  }
}

// Compose the `langfuse.observation.input` payload for the openclaw.llm span.
// Langfuse recognises a chat-shaped JSON string (array of {role, content}) and
// renders it as a conversation in the UI — making the system prompt and any
// openclaw-appended `extraSystemPrompt` directly visible instead of only the
// terminal user turn. Falls back to the plain user string when the caller
// didn't thread richer context through.
//
// Captures what the OpenAI-compat caller SENT. Does not yet capture what
// openclaw's cli-runner then injects (workspace MEMORY.md bootstrap, identity,
// soul) — deeper hook in cli-runner is a follow-up.
function buildGenerationInputAttributes(attrs: {
  prompt: string | undefined;
  extraSystemPrompt?: string;
  requestMessages?: OpenAiChatMessage[];
}): Record<string, string> {
  const messages: Array<{ role: string; content: unknown }> = [];
  if (attrs.extraSystemPrompt) {
    messages.push({ role: "system", content: attrs.extraSystemPrompt });
  }
  if (attrs.requestMessages) {
    for (const m of attrs.requestMessages) {
      const role = typeof m.role === "string" ? m.role : "user";
      messages.push({ role, content: m.content });
    }
  }
  if (messages.length > 0) {
    return { "langfuse.observation.input": JSON.stringify(messages) };
  }
  if (attrs.prompt !== undefined) {
    return { "langfuse.observation.input": attrs.prompt };
  }
  return {};
}

// Langfuse observation type mapping for agent item kinds. `tool` / `command` /
// `search` are shown as TOOL in Langfuse so they render with the tool icon;
// `patch` / `analysis` / unknown kinds stay SPAN.
const TOOL_KINDS = new Set(["tool", "command", "search"]);

function resolveItemObservationType(kind: string): "TOOL" | "SPAN" {
  return TOOL_KINDS.has(kind) ? "TOOL" : "SPAN";
}

function handleItemEvent(params: {
  data: AgentItemEventData;
  itemSpans: Map<string, Span>;
  parentCtx: ReturnType<typeof trace.setSpan>;
  traceContent: boolean;
}): void {
  const { data, itemSpans, parentCtx, traceContent } = params;
  if (data.phase === "start") {
    if (itemSpans.has(data.itemId)) {
      return;
    } // dedupe duplicate starts
    const span = openaiCompatTracer.startSpan(
      `openclaw.${data.kind}`,
      {
        attributes: {
          "langfuse.observation.type": resolveItemObservationType(data.kind),
          "openclaw.item.id": data.itemId,
          "openclaw.item.kind": data.kind,
          "openclaw.item.title": data.title,
          ...(data.name ? { "openclaw.item.name": data.name } : {}),
          ...(data.toolCallId ? { "openclaw.item.tool_call_id": data.toolCallId } : {}),
        },
      },
      parentCtx,
    );
    itemSpans.set(data.itemId, span);
    return;
  }
  if (data.phase === "end") {
    const span = itemSpans.get(data.itemId);
    if (!span) {
      return;
    }
    if (data.status === "failed" || data.status === "blocked") {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: data.error ?? data.status,
      });
    }
    if (traceContent && data.summary) {
      span.setAttribute("langfuse.observation.output", data.summary);
    }
    span.end();
    itemSpans.delete(data.itemId);
  }
}
