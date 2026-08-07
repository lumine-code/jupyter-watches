const { CompositeDisposable, Disposable } = require("atom");
const WatchesSession = require("./watches-session");
const { autocompleteConsumer } = require("./autocomplete");

const WATCHES_URI = "lumine://jupyter-watches";

let subscriptions = null;
let session = null;

function activate() {
  session = new WatchesSession();
  subscriptions = new CompositeDisposable(
    atom.commands.add("atom-workspace", {
      "jupyter-watches:toggle": () => atom.workspace.toggle(WATCHES_URI),
      "jupyter-watches:toggle-focus": () => toggleFocus(),
      // Packages > Jupyter Watches > Watch Selection dispatches at whatever
      // holds focus, so an editor scope left it dead off-editor. addWatch reads
      // the focused editor from the provider rather than the dispatch target,
      // so nothing else has to change.
      "jupyter-watches:add": () => addWatch(),
    }),
    // remove acts on the watch editor it was dispatched from, so it stays where
    // that editor is and is not in a menu.
    atom.commands.add("atom-text-editor:not([mini])", {
      "jupyter-watches:remove": (event) => removeWatch(event),
    }),
    atom.workspace.addOpener((uri) => (uri === WATCHES_URI ? createPane() : undefined)),
    new Disposable(() => destroyPane()),
    new Disposable(() => session.destroy()),
  );
}

// Reveal and focus the pane, or hand focus back to the centre when it already
// has it. This is what the keystroke binds rather than `toggle`: pressing it a
// second time should return you to your work, not hide a pane you are looking
// at. jupyter-monitor and jupyter-inspector use the same shape.
async function toggleFocus() {
  const element = atom.workspace.paneForURI(WATCHES_URI)?.element;
  const isFocused =
    element &&
    (element.offsetWidth !== 0 || element.offsetHeight !== 0) &&
    element.contains(document.activeElement);

  if (isFocused) {
    atom.workspace.getCenter().activate();
    return;
  }

  const item = await atom.workspace.open(WATCHES_URI, { searchAllPanes: true });
  item?.focus?.();
}

function deactivate() {
  subscriptions?.dispose();
  subscriptions = null;
  session = null;
}

function consumeJupyterKernel(provider) {
  session.setProvider(provider);
  return new Disposable(() => {
    // Every method on a wrapper throws once its kernel is gone, and without a
    // provider there is no kernel to watch anything on.
    session.setProvider(null);
    destroyPane();
  });
}

function consumeJupyterOutput(service) {
  session.setOutputService(service);
  return new Disposable(() => {
    session.setOutputService(null);
    destroyPane();
  });
}

/**
 * Completion in the watch editors. Optional: without it a watch editor is
 * still a real editor, it just offers no suggestions.
 */
function consumeAutocompleteWatchEditor(watchEditor) {
  return autocompleteConsumer.consume(watchEditor);
}

function createPane() {
  const WatchesPane = require("./watches-pane");
  return new WatchesPane(session);
}

function destroyPane() {
  atom.workspace
    .getPaneItems()
    .find((item) => item.getURI?.() === WATCHES_URI)
    ?.destroy();
}

/**
 * Watch the editor's selection, or add an empty watch to type into. The
 * focused editor comes from the provider, so a notebook's cell editors —
 * which the workspace does not report — are found too.
 */
async function addWatch() {
  const store = session.storeFor();
  if (!store) {
    atom.notifications.addWarning("jupyter-watches", {
      description: "No running kernel to watch on.",
    });
    return;
  }

  store.addWatchFromEditor(session.provider?.getFocusedEditor?.());
  await atom.workspace.open(WATCHES_URI, { searchAllPanes: true, activatePane: false });
}

/** Remove the watch whose editor dispatched the command. */
function removeWatch(event) {
  const editor = event?.currentTarget?.getModel?.() || event?.target?.getModel?.();
  if (!editor) {
    return;
  }

  // The active kernel's store first, then the rest: the command can fire from
  // a watch editor that belongs to a kernel that is no longer current.
  const stores = [session.storeFor(), ...session.allStores()].filter(Boolean);
  for (const store of stores) {
    if (store.removeWatchForEditor(editor)) {
      return;
    }
  }
}

module.exports = {
  activate,
  deactivate,
  consumeJupyterKernel,
  consumeJupyterOutput,
  consumeAutocompleteWatchEditor,
  WATCHES_URI,
  // The specs drive the session directly; nothing else should reach for it.
  getSession: () => session,
};
