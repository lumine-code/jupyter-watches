const { Emitter } = require("lumine");

// Each run owns a pure accumulator independently of the rendering service.
// Only a run created before the first data factory arrives buffers raw events.
class OutputHistory {
  constructor(limit, createAccumulator = null) {
    this.limit = limit;
    this.records = [];
    this.createAccumulator = createAccumulator;
    this.index = -1;
    this.runs = 0;
    this.emitter = new Emitter();
  }
  onDidUpdate(callback) {
    return this.emitter.on("did-update", callback);
  }
  get outputs() {
    return this.history.flatMap((run) => run);
  }
  get history() {
    return this.records.map((run) => run.accumulator?.outputs || run.pending);
  }
  setAccumulatorFactory(createAccumulator) {
    if (typeof createAccumulator !== "function")
      throw new TypeError("A pure output accumulator factory is required.");
    this.createAccumulator = createAccumulator;
    for (const run of this.records) {
      if (run.accumulator) continue;
      run.accumulator = createAccumulator();
      for (const output of run.pending) run.accumulator.append(output);
      run.pending = null;
    }
    this.emitter.emit("did-update");
  }
  startNewRun() {
    this.runs++;
    this.records.push({
      accumulator: this.createAccumulator?.() || null,
      pending: this.createAccumulator ? null : [],
    });
    if (this.records.length > this.limit) this.records.shift();
    this.index = this.records.length - 1;
    this.emitter.emit("did-update");
  }
  appendOutput(output) {
    if (!this.records.length) this.startNewRun();
    if (
      ![
        "stream",
        "execute_result",
        "display_data",
        "update_display_data",
        "clear_output",
        "error",
      ].includes(output.output_type)
    )
      return;
    const run = this.records.at(-1);
    if (run.accumulator) run.accumulator.append(output);
    else run.pending.push(structuredClone(output));
    this.emitter.emit("did-update");
  }
  setIndex(index) {
    this.index = Math.min(this.records.length - 1, Math.max(0, index));
    this.emitter.emit("did-update");
  }
  incrementIndex = () => this.setIndex(this.index + 1);
  decrementIndex = () => this.setIndex(this.index - 1);
  clear() {
    this.records = [];
    this.index = -1;
    this.emitter.emit("did-update");
  }
  destroy() {
    this.records = [];
    this.createAccumulator = null;
    this.emitter.dispose();
  }
}
module.exports = OutputHistory;
