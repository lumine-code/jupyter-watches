const { Emitter } = require("lumine");
const { randomUUID } = require("crypto");
const OutputHistory = require("./output-history");

// How many past values a watch keeps so they can be scrubbed via the history
// slider. Oldest values are dropped beyond this.
const WATCH_HISTORY_LIMIT = 25;

/**
 * One watch: an expression model and the history of its values.
 *
 * Each history run owns a pure output accumulator. Editors and renderer
 * generations belong to the view, so replacing either leaves this model live.
 */
class WatchStore {
  constructor(kernel, createAccumulator = null) {
    this.emitter = new Emitter();
    this.kernel = kernel;
    this.outputStore = new OutputHistory(WATCH_HISTORY_LIMIT, createAccumulator);
    this.isWatching = false;
    this.id = randomUUID();
    this.lastStartedAt = null;
    this.lastSettledAt = null;
    this.lastOutputAt = null;
    this.lastEvaluatedCode = null;
    this.lastOutputCode = null;
    this.lastOutputRequestId = null;
    this.lastKernelExecutionCount = null;
    this.lastKernelExecutionTime = null;

    this.code = "";
    this.focusRequested = false;
    this.generationSubscription = kernel.onDidChangeGeneration(() => {
      this._requestId = (this._requestId || 0) + 1;
      this.request?.dispose();
      this.request = null;
      this._running = false;
      this.emitter.emit("did-update");
    });
  }

  /**
   * Invoke the callback whenever the watching state changes.
   * @param {Function} callback
   * @returns {Disposable}
   */
  onDidUpdate(callback) {
    return this.emitter.on("did-update", callback);
  }

  toggleWatching = () => {
    if (this.destroyed) return;
    this.isWatching = !this.isWatching;
    this.emitter.emit("did-update");
    if (this.isWatching) {
      this.run();
    }
  };

  run = () => {
    if (this.destroyed || !this.isWatching || this._running) return;
    const code = this.getCode();
    if (!code) return;
    this._running = true;
    this.lastStartedAt = new Date().toISOString();
    this.lastSettledAt = null;
    this.lastEvaluatedCode = code;
    const requestId = (this._requestId = (this._requestId || 0) + 1);
    const generation = this.kernel.generation;
    this.outputStore.startNewRun(generation);
    const current = () =>
      !this.destroyed && requestId === this._requestId && generation === this.kernel.generation;
    let errorReceived = false;
    const append = (output) => {
      if (!current()) return;
      if (output.output_type === "error") errorReceived = true;
      if (
        ["stream", "execute_result", "display_data", "update_display_data", "error"].includes(
          output.output_type,
        )
      ) {
        this.lastOutputAt = new Date().toISOString();
        this.lastOutputCode = code;
        this.lastOutputRequestId = requestId;
        this.lastKernelGeneration = generation;
      }
      this.outputStore.appendOutput(output);
    };
    let request;
    try {
      request = this.request = this.kernel.request({
        type: "execute",
        purpose: "query",
        code,
        collectOutputs: false,
      });
    } catch (error) {
      this._running = false;
      append({
        output_type: "error",
        ename: error.name || "Error",
        evalue: error.message || String(error),
        traceback: [],
      });
      this.lastSettledAt = new Date().toISOString();
      this.emitter.emit("did-update");
      return;
    }
    const outputSubscription = request.onDidOutput(append);
    void request.done
      .then((result) => {
        if (!current()) return;
        this._running = false;
        this.request = null;
        this.lastSettledAt = new Date().toISOString();
        this.lastKernelExecutionCount = this.kernel.executionCount ?? null;
        this.lastKernelExecutionTime = this.kernel.lastExecutionTime ?? null;
        this.emitter.emit("did-update");
        if (!["ok", "cancelled"].includes(result.status) && !errorReceived) {
          append({
            output_type: "error",
            ename: result.error?.ename || result.status,
            evalue: result.error?.evalue || `Watch evaluation ${result.status}.`,
            traceback: result.error?.traceback || [],
          });
        }
      })
      .finally(() => {
        outputSubscription.dispose();
        request.dispose();
      });
  };

  setCode = (code) => {
    if (this.destroyed) return;
    this.code = String(code);
    this.emitter.emit("did-update");
  };
  getCode = () => this.code;
  focus = () => {
    if (this.destroyed) return;
    this.focusRequested = true;
    this.emitter.emit("did-update");
  };

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.isWatching = false;
    this._running = false;
    this.request?.dispose();
    this.request = null;
    this.generationSubscription?.dispose();
    this.outputStore.destroy();
    this.emitter.dispose();
  }
}

module.exports = { WatchStore, WATCH_HISTORY_LIMIT };
