const { Emitter } = require("lumine");

// Raw notebook outputs belong to the watch, independently of the renderer.
// Each run remains a separate output area, including clear_output messages.
class OutputHistory {
  constructor(limit) {
    this.limit = limit;
    this.history = [];
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
  startNewRun() {
    this.runs++;
    this.history.push([]);
    if (this.history.length > this.limit) this.history.shift();
    this.index = this.history.length - 1;
    this.emitter.emit("did-update");
  }
  appendOutput(output) {
    if (!this.history.length) this.startNewRun();
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
    this.history.at(-1).push(structuredClone(output));
    this.emitter.emit("did-update");
  }
  setIndex(index) {
    this.index = Math.min(this.history.length - 1, Math.max(0, index));
    this.emitter.emit("did-update");
  }
  incrementIndex = () => this.setIndex(this.index + 1);
  decrementIndex = () => this.setIndex(this.index - 1);
  clear() {
    this.history = [];
    this.index = -1;
    this.emitter.emit("did-update");
  }
  destroy() {
    this.history = [];
    this.emitter.dispose();
  }
}
module.exports = OutputHistory;
