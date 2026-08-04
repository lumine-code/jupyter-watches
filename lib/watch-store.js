const { Emitter } = require("atom");
const { autocompleteConsumer } = require("./autocomplete");

// How many past values a watch keeps so they can be scrubbed via the history
// slider. Oldest values are dropped beyond this.
const WATCH_HISTORY_LIMIT = 25;

/**
 * One watch: an expression editor and the history of its values.
 *
 * The kernel is a `jupyter.kernel` wrapper and the output store comes from
 * `jupyter.output` — both jupyter-repl's, reached only through the services.
 */
class WatchStore {
  constructor(kernel, outputService) {
    this.emitter = new Emitter();
    this.kernel = kernel;
    this.outputStore = new outputService.OutputStore(WATCH_HISTORY_LIMIT);
    this.isWatching = false;

    this.editor = atom.workspace.buildTextEditor({
      softWrapped: true,
      lineNumberGutterVisible: false,
    });
    const grammar = this.kernel.grammar;
    if (grammar) {
      atom.grammars.assignLanguageMode(this.editor.getBuffer(), grammar.scopeName);
    }
    this.editor.moveToTop();
    this.editor.element.classList.add("watch-input");
    autocompleteConsumer.watchPanelEditor(this.editor);

    // Re-run the watch when its editor loses focus, so an edited expression
    // takes effect without an explicit confirm.
    this._blurHandler = () => {
      if (this.isWatching) {
        this.run();
      }
    };
    this.editor.element.addEventListener("blur", this._blurHandler);

    // Enter runs the watch (starting it if needed); Shift+Enter inserts a
    // newline (see keymaps).
    this._confirmCommand = atom.commands.add(this.editor.element, {
      "core:confirm": () => {
        if (!this.isWatching) {
          this.toggleWatching();
        } else {
          this.run();
        }
      },
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
    this.isWatching = !this.isWatching;
    this.emitter.emit("did-update");
    if (this.isWatching) {
      this.run();
    }
  };

  run = () => {
    if (!this.isWatching) return;

    const code = this.getCode();
    if (code && code.length > 0) {
      // Start a new history entry so each run accumulates as a scrubbable
      // value instead of replacing the previous one.
      this.outputStore.startNewRun();
      this.kernel.executeWatch(code, (result) => {
        this.outputStore.appendOutput(result);
      });
    }
  };

  setCode = (code) => {
    this.editor.setText(code);
  };

  getCode = () => {
    return this.editor.getText();
  };

  focus = () => {
    this.editor.element.focus();
  };

  destroy() {
    if (this._blurHandler && this.editor) {
      this.editor.element.removeEventListener("blur", this._blurHandler);
      this._blurHandler = null;
    }
    this._confirmCommand?.dispose();
    this._confirmCommand = null;
    // Destroying the editor also releases its autocomplete watch.
    this.editor?.destroy();
    this.editor = null;
  }
}

module.exports = { WatchStore, WATCH_HISTORY_LIMIT };
