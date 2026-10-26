/** @jsx etch.dom */
const InputBudget = require("./input-budget");
const etch = require("@lumine-code/etch");
const { CompositeDisposable } = require("lumine");
const { autocompleteConsumer } = require("./autocomplete");

/** One watch: its expression editor, its controls, and its value history. */
class Watch {
  constructor({ store, outputService, onRemove, registerEditor }) {
    this.store = store;
    this.outputService = outputService;
    this.onRemove = onRemove;
    etch.initialize(this);

    this.editor = lumine.workspace.buildTextEditor({
      softWrapped: true,
      lineNumberGutterVisible: false,
    });
    this.editor.setText(store.codeSource);
    if (store.kernel.grammar)
      lumine.grammars.assignLanguageMode(this.editor.getBuffer(), store.kernel.grammar.scopeName);
    this.editor.element.classList.add("watch-input");
    this.editor.element.setAttribute("input", "");
    this.refs.editorContainer.appendChild(this.editor.element);
    this.budget = new InputBudget(this.editor, this.refs.editorContainer, {
      limit: 64 * 1024,
      label: "Watch expression",
    });
    autocompleteConsumer.watchPanelEditor(this.editor);
    const sync = () => {
      this._settingText = true;
      try {
        this.budget.sync(store.codeSource);
      } finally {
        this._settingText = false;
      }
      if (store.focusRequested) {
        store.focusRequested = false;
        this.editor.element.focus();
      }
      etch.update(this);
    };
    this.blur = () => {
      if (store.isWatching) store.run();
    };
    this.editor.element.addEventListener("blur", this.blur);
    this.disposables = new CompositeDisposable(
      store.onDidUpdate(sync),
      store.outputStore.onDidUpdate(() => etch.update(this)),
      this.editor.getBuffer().onDidChangeText(() => {
        if (this._settingText) return;
        this.budget.validate();
        store.setCode(this.editor.getBuffer().getTextSnapshot());
      }),
      lumine.commands.add(this.editor.element, { "core:confirm": () => this.handleRun() }),
      lumine.commands.add(this.refs.history, {
        "core:move-left": () => store.outputStore.decrementIndex(),
        "core:move-right": () => store.outputStore.incrementIndex(),
      }),
    );
    const registration = registerEditor?.(this.editor);
    if (registration) this.disposables.add(registration);
    sync();
  }

  handleRun = () => {
    if (!this.budget.validate()) return;
    if (!this.store.isWatching) {
      this.store.toggleWatching();
    } else {
      this.store.run();
    }
  };

  handlePause = () => {
    if (this.store.isWatching) {
      this.store.toggleWatching();
    }
  };

  handleClear = () => {
    this.store.outputStore.clear();
  };

  handleRemove = () => {
    this.onRemove?.(this.store);
  };

  render() {
    const history = this.store.outputStore;
    const outputs = history.history[history.index] || [];

    return (
      <div className="watch-view">
        <div className="watch-toolbar">
          <button
            className="btn btn-xs icon icon-playback-play watch-run-btn"
            onClick={this.handleRun}
            title="Run watch"
            disabled={this.store.isWatching || Boolean(this.store.codeError)}
          />
          <button
            className="btn btn-xs icon icon-playback-pause watch-pause-btn"
            onClick={this.handlePause}
            title="Pause watching"
            disabled={!this.store.isWatching}
          />
          <button
            className="btn btn-xs icon icon-trashcan watch-clear-btn"
            onClick={this.handleClear}
            title="Clear output"
          />
          <button
            className="btn btn-xs icon icon-x watch-remove-btn"
            onClick={this.handleRemove}
            title="Remove watch"
          />
        </div>
        <div className="watch-editor-container" ref="editorContainer" />
        <div className="history output-area" ref="history">
          {history.history.length > 0 ? (
            <div className="slider">
              <div className="current-output">
                <button
                  className="btn btn-xs icon icon-chevron-left"
                  onClick={() => history.decrementIndex()}
                  title="Previous run"
                />
                <span>
                  {String(history.index + 1)}/{String(history.history.length)}
                </span>
                <button
                  className="btn btn-xs icon icon-chevron-right"
                  onClick={() => history.incrementIndex()}
                  title="Next run"
                />
              </div>
              <input
                className="input-range"
                type="range"
                min="0"
                max={String(history.history.length - 1)}
                value={String(history.index)}
                onChange={(event) => history.setIndex(Number(event.target.value))}
              />
            </div>
          ) : null}
          <div
            className="multiline-container native-key-bindings"
            tabIndex={-1}
            style={{
              fontSize: `${lumine.config.get("jupyter-repl.outputAreaFontSize") || lumine.config.get("editor.fontSize")}px`,
            }}
            attributes={{
              "data-wrap-output": String(lumine.config.get("jupyter-repl.wrapOutput") ?? true),
            }}
          >
            {outputs.map((output) =>
              this.outputService ? (
                this.outputService.renderDisplay(this.outputService.normalizeOutput(output), {
                  kernel: this.store.kernel,
                  kernelGeneration: history.selectedKernelGeneration,
                })
              ) : (
                <pre>
                  {output.output_type === "stream"
                    ? Array.isArray(output.text)
                      ? output.text.join("")
                      : output.text
                    : output.output_type === "error"
                      ? `${output.ename}: ${output.evalue}`
                      : output.data?.["text/plain"] || "Rich output requires the Jupyter renderer."}
                </pre>
              ),
            )}
          </div>
        </div>
      </div>
    );
  }

  update({ outputService, onRemove }) {
    this.outputService = outputService;
    this.onRemove = onRemove;
    return etch.update(this);
  }

  destroy() {
    this.disposables.dispose();
    this.editor.element.removeEventListener("blur", this.blur);
    this.budget.dispose();
    this.editor.destroy();
    return etch.destroySync(this);
  }
}

module.exports = Watch;
