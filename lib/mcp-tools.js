const MAX_RESPONSE_BYTES = 32768;
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const kernelIdSchema = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  description:
    "Exact kernel ID returned by ListJupyterKernels. Never defaults to the active kernel.",
};
const maxCharsSchema = {
  type: "integer",
  minimum: 64,
  maximum: 8000,
  default: 1000,
  description:
    "Maximum characters per expression or output field. The entire response is limited to 32 KiB.",
};

function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max)
    throw new TypeError(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}

function text(value, max) {
  if (typeof value !== "string") return null;
  let result = value.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
  return result;
}

function textValue(value, max) {
  if (!Array.isArray(value)) return text(value, max);
  let result = "";
  for (const part of value) {
    if (typeof part === "string") result += text(part, max - result.length);
    if (result.length >= max) break;
  }
  return result;
}

function size(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function context(getSession, args) {
  if (!args || typeof args.kernelId !== "string" || !args.kernelId || args.kernelId.length > 256)
    throw new TypeError(
      "kernelId is required and must be a nonempty string of at most 256 characters.",
    );
  const base = { kernelId: args.kernelId, source: "cached-watch-output" };
  const session = getSession();
  if (!session?.provider || session.destroyed)
    return {
      base: {
        ...base,
        status: "provider-unavailable",
        reason: "The jupyter.kernel provider is not connected.",
      },
    };
  let kernel;
  try {
    kernel = session.provider
      .getRunningKernels()
      .find((entry) => entry.id === args.kernelId && !entry.destroyed);
  } catch {
    return {
      base: {
        ...base,
        status: "provider-unavailable",
        reason: "The kernel provider is no longer available.",
      },
    };
  }
  if (!kernel)
    return {
      base: { ...base, status: "kernel-not-found", reason: "No running kernel has this ID." },
    };
  if (!session.outputService)
    return {
      base: {
        ...base,
        status: "output-unavailable",
        reason: "The jupyter.output provider is not connected.",
      },
    };
  // Creating a store would register an idle listener. Cached MCP reads remain
  // passive even when the panel was never opened or its services disappeared.
  const store = session.stores.get(kernel);
  if (!store || store.destroyed)
    return {
      base: {
        ...base,
        status: "cache-unavailable",
        reason:
          "No Watches store exists for this kernel. Add a watch explicitly in the panel first.",
      },
    };
  return { store, kernel, base: { ...base, status: "available" } };
}

function outputSnapshot(output, maxChars) {
  const outputType = text(output?.output_type, 32);
  const result = { outputType, text: null, mimeTypes: [], truncated: false };
  if (outputType === "stream") {
    result.name = text(output.name, 64);
    result.text = textValue(output.text, maxChars);
    const length = Array.isArray(output.text)
      ? output.text.reduce((sum, part) => sum + (typeof part === "string" ? part.length : 0), 0)
      : typeof output.text === "string"
        ? output.text.length
        : 0;
    result.truncated = length > (result.text?.length || 0);
  } else if (outputType === "execute_result" || outputType === "display_data") {
    result.mimeTypes = Object.keys(output.data || {})
      .slice(0, 32)
      .map((mime) => text(mime, 128));
    result.text = textValue(output.data?.["text/plain"], maxChars);
    const raw = output.data?.["text/plain"];
    result.truncated =
      typeof raw === "string"
        ? raw.length > (result.text?.length || 0)
        : Array.isArray(raw) &&
          raw.reduce((sum, part) => sum + (typeof part === "string" ? part.length : 0), 0) >
            (result.text?.length || 0);
    result.richDataOmitted = result.mimeTypes.some((mime) => mime !== "text/plain");
  } else if (outputType === "error") {
    result.error = {
      name: text(output.ename, 128),
      message: text(output.evalue, maxChars),
      traceback: textValue(
        Array.isArray(output.traceback)
          ? output.traceback.slice(0, 20).flatMap((line) => [line, "\n"])
          : output.traceback,
        maxChars,
      ),
    };
    result.truncated =
      (typeof output.evalue === "string" && output.evalue.length > maxChars) ||
      (Array.isArray(output.traceback) && output.traceback.length > 20);
  }
  return result;
}

function watchSnapshot(watch, kernel, maxChars) {
  const code = watch.getCode();
  const outputs = watch.outputStore.outputs || [];
  const available = outputs.length > 0;
  let stale = null;
  if (available) {
    if (
      watch._running ||
      !watch.lastSettledAt ||
      watch.lastOutputCode !== code ||
      watch.lastOutputRequestId !== watch._requestId ||
      (kernel.executionState && kernel.executionState !== "idle") ||
      watch.lastKernelExecutionCount !== (kernel.executionCount ?? null) ||
      watch.lastKernelExecutionTime !== (kernel.lastExecutionTime ?? null)
    )
      stale = true;
    else if (
      kernel.executionState === "idle" &&
      Number.isFinite(watch.lastKernelExecutionCount) &&
      typeof watch.lastKernelExecutionTime === "string"
    )
      stale = false;
  }
  const expression = text(code, maxChars);
  const evaluatedExpression = text(watch.lastOutputCode, maxChars);
  return {
    watchId: watch.id,
    expression,
    evaluatedExpression,
    expressionTruncated: expression !== code || evaluatedExpression !== watch.lastOutputCode,
    isWatching: Boolean(watch.isWatching),
    running: Boolean(watch._running),
    availability: available ? "available" : "no-output",
    stale,
    cachedAt: available ? watch.lastOutputAt : null,
    lastStartedAt: watch.lastStartedAt,
    lastSettledAt: watch.lastSettledAt,
    executionCount: watch.lastKernelExecutionCount,
    lastExecutionTime: watch.lastKernelExecutionTime,
    outputCount: outputs.length,
    latest: available ? outputSnapshot(outputs[outputs.length - 1], maxChars) : null,
  };
}

function list(getSession, args = {}) {
  const offset = integer(args.offset, 0, 0, 1000000, "offset");
  const limit = integer(args.limit, 50, 1, 200, "limit");
  const maxChars = integer(args.maxChars, 1000, 64, 8000, "maxChars");
  const { base, kernel, store } = context(getSession, args);
  if (!store) return { ...base, watches: [], total: 0, offset, nextOffset: null };
  const watches = store.watches.filter((watch) => !watch.destroyed);
  const result = {
    ...base,
    watches: [],
    total: watches.length,
    offset,
    requestedLimit: limit,
    nextOffset: null,
    responseLimited: false,
  };
  for (const watch of watches.slice(offset, offset + limit)) {
    let chars = maxChars;
    let snapshot = watchSnapshot(watch, kernel, chars);
    while (size(snapshot) > MAX_RESPONSE_BYTES / 2 && chars > 16) {
      chars = Math.floor(chars / 2);
      snapshot = watchSnapshot(watch, kernel, chars);
    }
    result.watches.push(snapshot);
    if (size(result) > MAX_RESPONSE_BYTES - 128) {
      result.watches.pop();
      result.responseLimited = true;
      break;
    }
  }
  const next = offset + result.watches.length;
  result.nextOffset = next < watches.length ? next : null;
  return result;
}

function get(getSession, args = {}) {
  if (typeof args.watchId !== "string" || !args.watchId || args.watchId.length > 256)
    throw new TypeError(
      "watchId is required and must be a nonempty string of at most 256 characters.",
    );
  const historyLimit = integer(args.historyLimit, 5, 0, 25, "historyLimit");
  let maxChars = integer(args.maxChars, 1000, 64, 8000, "maxChars");
  const { base, kernel, store } = context(getSession, args);
  if (!store) return { ...base, watch: null };
  const watch = store.watches.find((entry) => !entry.destroyed && entry.id === args.watchId);
  if (!watch)
    return {
      ...base,
      status: "not-found",
      reason: "This watch ID is not present in this kernel's cache.",
      watch: null,
    };
  const outputs = watch.outputStore.outputs || [];
  const build = () => ({
    ...base,
    watch: watchSnapshot(watch, kernel, maxChars),
    historyKind: "output-entries",
    history: (historyLimit ? outputs.slice(-historyLimit) : []).map((output) =>
      outputSnapshot(output, maxChars),
    ),
    historyTruncated: outputs.length > historyLimit,
    historyTimestampsAvailable: false,
  });
  let result = build();
  while (size(result) > MAX_RESPONSE_BYTES && maxChars > 16) {
    maxChars = Math.floor(maxChars / 2);
    result = build();
  }
  while (size(result) > MAX_RESPONSE_BYTES && result.history.length) {
    result.history.shift();
    result.historyTruncated = true;
  }
  return result;
}

function createTools(getSession) {
  return [
    {
      name: "ListJupyterWatches",
      title: "List cached Jupyter watches",
      description:
        "List existing watches for one explicit kernel with stable watch IDs, expressions, paused/running state and bounded latest cached output. Does not create watches, open panels, execute expressions or attach idle listeners. Timestamps describe previous evaluations; staleness is conservative.",
      inputSchema: {
        type: "object",
        properties: {
          kernelId: kernelIdSchema,
          offset: { type: "integer", minimum: 0, maximum: 1000000, default: 0 },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          maxChars: maxCharsSchema,
        },
        required: ["kernelId"],
        additionalProperties: false,
      },
      annotations,
      execute: (args) => list(getSession, args),
    },
    {
      name: "GetJupyterWatch",
      title: "Get cached Jupyter watch output",
      description:
        "Read one existing watch by kernel ID and watch ID, with bounded retained output history. History entries are notebook output entries, not complete runs; individual timestamps are unavailable. Returns plain text/error summaries and MIME names, omitting rich/binary data. Never runs or resumes the watch.",
      inputSchema: {
        type: "object",
        properties: {
          kernelId: kernelIdSchema,
          watchId: { type: "string", minLength: 1, maxLength: 256 },
          historyLimit: { type: "integer", minimum: 0, maximum: 25, default: 5 },
          maxChars: maxCharsSchema,
        },
        required: ["kernelId", "watchId"],
        additionalProperties: false,
      },
      annotations,
      execute: (args) => get(getSession, args),
    },
  ];
}

module.exports = { createTools, MAX_RESPONSE_BYTES };
