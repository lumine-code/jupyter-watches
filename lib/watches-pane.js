const { CompositeDisposable, Disposable, Emitter } = require("lumine");
const Watches = require("./watches");

const WATCHES_URI = "lumine://jupyter-watches";

class WatchesPane {
  constructor(session) {
    this.emitter = new Emitter();
    this.destroyed = false;
    this.element = document.createElement("div");
    this.element.classList.add("jupyter-watches");
    this.element.tabIndex = -1;

    this.component = new Watches({ session });
    this.element.appendChild(this.component.element);

    this.disposer = new CompositeDisposable(new Disposable(() => this.component.destroy()));
  }

  getTitle = () => "Watches";
  getIconName = () => "eye-watch";
  getURI = () => WATCHES_URI;
  getDefaultLocation = () => "right";
  getAllowedLocations = () => ["left", "right"];

  focus = () => {
    const editor = this.element.querySelector("lumine-text-editor.watch-input");
    (editor || this.element).focus?.({ preventScroll: true });
  };

  /**
   * A pane only drops an item it is told about. Destroying the item directly —
   * which is what happens when the kernel service goes away — leaves the tab
   * behind without this.
   *
   * @param {Function} callback
   * @returns {Disposable}
   */
  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.disposer.dispose();
    this.element.remove();
    this.emitter.emit("did-destroy");
    this.emitter.dispose();
  }
}

module.exports = WatchesPane;
module.exports.WATCHES_URI = WATCHES_URI;
