const { Disposable, Emitter } = require("lumine");

// Controlled public request handles. receive drives output/completion in old
// fixtures; production consumers only observe onDidOutput and done.
function recordRequest(kernel, specification) {
  if (!["user", "query"].includes(specification.purpose))
    throw new TypeError("Request purpose is required");
  let resolve;
  let finished = false;
  let idle = false;
  let reply = false;
  const outputs = [];
  const listeners = new Set();
  const handle = {
    id: String((kernel._requestSequence = (kernel._requestSequence || 0) + 1)),
    generation: kernel.generation ?? 0,
    done: new Promise((fulfill) => {
      resolve = fulfill;
    }),
    specification,
    code: specification.code,
    watch: specification.purpose === "query",
    onDidOutput(callback) {
      listeners.add(callback);
      return new Disposable(() => listeners.delete(callback));
    },
    finish(result = {}) {
      if (finished) return;
      finished = true;
      specification.signal?.removeEventListener("abort", abort);
      resolve({ status: "ok", outputs: [...outputs], executionCount: null, ...result });
    },
    dispose() {
      handle.disposed = true;
      listeners.clear();
      handle.finish({ status: "cancelled" });
    },
    receive(output) {
      if (finished || handle.disposed) return;
      if (output.output_type === "error") {
        if (specification.collectOutputs !== false) outputs.push(output);
        for (const callback of listeners) callback(output);
        handle.finish({ status: "error", error: output });
      } else if (output.output_type === "status") {
        if (output.execution_state === "idle") idle = true;
        if (idle && (specification.purpose !== "user" || reply)) handle.finish();
      } else if (output.stream === "status") {
        reply = true;
        if (specification.purpose !== "user" || idle) handle.finish({ status: output.data });
      } else {
        if (specification.collectOutputs !== false) outputs.push(output);
        for (const callback of listeners) callback(output);
      }
    },
  };
  const abort = () => handle.dispose();
  if (specification.signal?.aborted) handle.dispose();
  else specification.signal?.addEventListener("abort", abort, { once: true });
  if (kernel.requests) kernel.requests.push(handle);
  if (specification.type === "inspect") {
    kernel.inspected?.push({ expression: specification.code, cursorPos: specification.cursorPos });
    Promise.resolve(
      kernel.inspectReply?.(specification.code, specification.cursorPos) ??
        kernel.inspectResult ?? { found: true, data: { "text/plain": "docs" } },
    ).then(
      (data) => handle.finish({ data }),
      (error) =>
        handle.finish({
          status: "error",
          error: { ename: error.name, evalue: error.message, traceback: [] },
        }),
    );
  } else {
    kernel.executed?.push(specification.code);
    kernel.lastOnResults = handle.receive;
  }
  return handle;
}
async function settle() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}
function generationKernel(kernel) {
  const emitter = new Emitter();
  kernel.generation = 0;
  kernel.onDidChangeGeneration = (callback) => emitter.on("generation", callback);
  kernel.advanceGeneration = () => {
    kernel.generation++;
    emitter.emit("generation", kernel.generation);
  };
  return kernel;
}
// A pure test value with persistent stream cursor and clear/update state.
// It never refers to the rendering provider that supplied its factory.
function createOutputAccumulator() {
  const outputs = [];
  const streamStates = new WeakMap();
  let clearPending = false;
  return {
    outputs,
    append(event) {
      const output = structuredClone(event);
      if (output.output_type === "clear_output") {
        clearPending = Boolean(output.wait);
        if (!clearPending) outputs.length = 0;
        return;
      }
      if (output.output_type === "update_display_data") {
        for (const previous of outputs) {
          if (
            output.transient?.display_id &&
            previous.transient?.display_id === output.transient.display_id
          ) {
            previous.data = output.data;
            previous.metadata = output.metadata;
          }
        }
        return;
      }
      if (clearPending) {
        outputs.length = 0;
        clearPending = false;
      }
      if (output.output_type !== "stream") {
        outputs.push(output);
        return;
      }
      const previous = outputs.at(-1);
      const target =
        previous?.output_type === "stream" && previous.name === output.name ? previous : output;
      if (target === output) outputs.push(target);
      let state = streamStates.get(target);
      if (!state) {
        state = { lines: [[]], row: 0, column: 0 };
        streamStates.set(target, state);
      }
      for (const char of Array.isArray(output.text) ? output.text.join("") : output.text || "") {
        if (char === "\r") state.column = 0;
        else if (char === "\n") {
          state.row++;
          state.column = 0;
          state.lines[state.row] ||= [];
        } else {
          state.lines[state.row][state.column++] = char;
        }
      }
      target.text = state.lines.map((line) => line.join("")).join("\n");
    },
  };
}
module.exports = { recordRequest, settle, generationKernel, createOutputAccumulator };
