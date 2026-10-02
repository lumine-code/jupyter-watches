const { Emitter } = require("lumine");
const WatchesStore = require("./watches-store");

/**
 * What the panel sees: the active kernel, and one watches store per kernel.
 *
 * The stores used to hang off jupyter-repl's internal Kernel objects. This
 * package only ever holds the wrappers `jupyter.kernel` hands over, so it
 * keeps its own map keyed by wrapper and drops an entry when its kernel goes.
 */
class WatchesSession {
  constructor() {
    this.emitter = new Emitter();
    this.provider = null;
    this.outputService = null;
    this.kernel = null;
    this.stores = new Map();
    this.subscriptions = [];
  }

  /**
   * Invoke the callback whenever the active kernel changes, including to null.
   * @param {Function} callback
   * @returns {Disposable}
   */
  onDidChangeCurrentKernel(callback) {
    return this.emitter.on("did-change-kernel", callback);
  }

  setProvider(provider) {
    if (provider === this.provider || this.destroyed) return;
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.clear();
    this.provider = provider;
    this.subscriptions = provider
      ? [
          provider.onDidChangeKernel((kernel) => {
            if (this.provider === provider) this.setKernel(kernel);
          }),
          provider.onDidRemoveKernel((kernel) => {
            if (this.provider === provider) this.forget(kernel);
          }),
        ]
      : [];
    this.kernel = provider ? provider.getActiveKernel() : null;
    this.emitter.emit("did-change-kernel", this.kernel);
  }

  setOutputService(outputService) {
    if (this.destroyed || outputService === this.outputService) return;
    // Output stores belong to the particular service generation that built
    // them, including when a replacement arrives before the old one detaches.
    this.clear();
    this.outputService = outputService;
    this.emitter.emit("did-change-kernel", this.kernel);
  }

  setKernel(kernel) {
    if (kernel === this.kernel) {
      return;
    }
    this.kernel = kernel || null;
    this.emitter.emit("did-change-kernel", this.kernel);
  }

  /**
   * The watches store for a kernel, made on first ask. Null without a kernel
   * or without the `jupyter.output` service the stores record through.
   *
   * @param {JupyterKernel} [kernel] - Defaults to the active one
   * @returns {WatchesStore|null}
   */
  storeFor(kernel = this.kernel) {
    if (this.destroyed || !kernel || !this.outputService) {
      return null;
    }
    if (!this.stores.has(kernel)) {
      this.stores.set(kernel, new WatchesStore(kernel, this.outputService));
    }
    return this.stores.get(kernel);
  }

  /** Every live store, for commands that search across kernels. */
  allStores() {
    return [...this.stores.values()];
  }

  forget(kernel) {
    this.stores.get(kernel)?.destroy();
    this.stores.delete(kernel);
    if (this.kernel === kernel) {
      this.setKernel(null);
    }
  }

  clear() {
    for (const store of this.stores.values()) {
      store.destroy();
    }
    this.stores.clear();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions = [];
    this.clear();
    this.provider = null;
    this.outputService = null;
    this.setKernel(null);
    this.emitter.dispose();
  }
}

module.exports = WatchesSession;
