const { Emitter } = require("lumine");
const { WatchStore } = require("./watch-store");

/**
 * One kernel's watches.
 *
 * This used to splice itself into jupyter-repl's internal watch-callback
 * array; the service's `onDidBecomeIdle` is that hook with a Disposable, so
 * every watch re-runs when an execution finishes anywhere on the kernel.
 */
class WatchesStore {
  constructor(kernel, outputService) {
    this.emitter = new Emitter();
    this.kernel = kernel;
    this.outputService = outputService;
    this.watches = [];
    this.idleSubscription = kernel.onDidBecomeIdle(() => this.run());
  }

  /**
   * Invoke the callback whenever the set of watches changes.
   * @param {Function} callback
   * @returns {Disposable}
   */
  onDidUpdate(callback) {
    return this.emitter.on("did-update", callback);
  }

  createWatch = () => {
    const lastWatch = this.watches[this.watches.length - 1];

    if (!lastWatch || lastWatch.getCode().trim() !== "") {
      const watch = new WatchStore(this.kernel, this.outputService);
      this.watches.push(watch);
      this.emitter.emit("did-update");
      return watch;
    }

    return lastWatch;
  };

  addWatch = () => {
    this.createWatch().focus();
  };

  /**
   * Add a watch on the editor's selection, or an empty one to type into.
   * @param {TextEditor} [editor]
   */
  addWatchFromEditor = (editor) => {
    const watchText = editor?.getSelectedText?.();

    if (!watchText) {
      this.addWatch();
    } else {
      const watch = this.createWatch();
      watch.setCode(watchText);
      watch.toggleWatching();
    }
  };

  removeWatchByRef = (watch) => {
    const index = this.watches.indexOf(watch);
    if (index === -1) return;

    watch.destroy();
    this.watches.splice(index, 1);
    this.emitter.emit("did-update");
  };

  removeWatchForEditor = (editor) => {
    const watch = this.watches.find((candidate) => candidate.editor === editor);
    if (!watch) return false;

    this.removeWatchByRef(watch);
    return true;
  };

  run = () => {
    this.watches.forEach((watch) => watch.run());
  };

  destroy() {
    // Only subscriptions and editors: the wrapper's methods throw once its
    // kernel is gone, and teardown is exactly when that can be true.
    this.idleSubscription.dispose();
    this.watches.forEach((watch) => watch.destroy());
    this.watches = [];
    this.emitter.emit("did-update");
  }
}

module.exports = WatchesStore;
