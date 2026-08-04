const etch = require("@lumine-code/etch");
const { CompositeDisposable } = require("atom");
const Watch = require("./watch");

const WATCHES_URI = "lumine://jupyter-watches";

function renderEmptyMessage(lines) {
  return (
    <background-tips>
      <ul className="centered background-message">{lines}</ul>
    </background-tips>
  );
}

/** The current kernel's watches, with a button to add another. */
class Watches {
  constructor({ session }) {
    this.session = session;
    this.watchesSubscription = null;

    etch.initialize(this);

    this.disposables = new CompositeDisposable(
      this.session.onDidChangeCurrentKernel(() => this.watchCurrentKernel()),
    );

    this.watchCurrentKernel();
  }

  get watchesStore() {
    return this.session.storeFor();
  }

  // Watches belong to a kernel, so the subscription moves with the session's.
  watchCurrentKernel() {
    this.watchesSubscription?.dispose();
    const watchesStore = this.watchesStore;
    this.watchesSubscription = watchesStore
      ? watchesStore.onDidUpdate(() => etch.update(this))
      : null;
    etch.update(this);
  }

  handleRemoveWatch = (watch) => {
    this.watchesStore?.removeWatchByRef(watch);
  };

  render() {
    const watchesStore = this.watchesStore;

    if (!watchesStore) {
      // Unless asked to stay, the view closes itself rather than sitting there
      // empty; the hide is deferred so it does not run inside a render.
      if (!atom.config.get("jupyter-watches.keepOpen")) {
        etch.getScheduler().updateDocument(() => atom.workspace.hide(WATCHES_URI));
      }
      return (
        <div className="sidebar watch-sidebar">
          {renderEmptyMessage([<li>No kernel running</li>])}
        </div>
      );
    }

    return (
      <div className="sidebar watch-sidebar">
        {watchesStore.watches.map((watch) => (
          <Watch
            key={watch.editor.id}
            store={watch}
            outputService={this.session.outputService}
            onRemove={this.handleRemoveWatch}
          />
        ))}
        <div className="btn-group">
          <button
            className="btn btn-primary icon icon-plus"
            onClick={() => watchesStore.addWatch()}
          >
            Add watch
          </button>
        </div>
      </div>
    );
  }

  update() {
    return etch.update(this);
  }

  destroy() {
    this.watchesSubscription?.dispose();
    this.disposables.dispose();
    return etch.destroy(this);
  }
}

module.exports = Watches;
module.exports.WATCHES_URI = WATCHES_URI;
