/** @jsx etch.dom */
const etch = require("@lumine-code/etch");

/** One watch: its expression editor, its controls, and its value history. */
class Watch {
  constructor({ store, outputService, onRemove }) {
    this.store = store;
    this.outputService = outputService;
    this.onRemove = onRemove;
    etch.initialize(this);

    // The expression editor is a real TextEditor, so it is attached once and
    // never re-created by a patch.
    if (this.store.editor) {
      this.refs.editorContainer.appendChild(this.store.editor.element);
    }

    this.subscription = this.store.onDidUpdate(() => etch.update(this));
  }

  handleRun = () => {
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
    const History = this.outputService.History;

    return (
      <div className="watch-view">
        <div className="watch-toolbar">
          <button
            className="btn btn-xs icon icon-playback-play watch-run-btn"
            onClick={this.handleRun}
            title="Run watch"
            disabled={this.store.isWatching}
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
        <History store={this.store.outputStore} />
      </div>
    );
  }

  update({ store, onRemove }) {
    this.onRemove = onRemove;
    if (store !== this.store) {
      this.subscription.dispose();
      this.store = store;
      this.subscription = this.store.onDidUpdate(() => etch.update(this));
    }
    return etch.update(this);
  }

  destroy() {
    this.subscription.dispose();
    // The editor belongs to the watch store, which destroys it; detach it so
    // the patch does not take it down with this component.
    this.store.editor?.element.remove();
    return etch.destroy(this);
  }
}

module.exports = Watch;
