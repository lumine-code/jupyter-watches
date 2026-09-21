const { CompositeDisposable, Disposable } = require("lumine");
const WatchesSession = require("./watches-session");
const { autocompleteConsumer } = require("./autocomplete");
const etch = require("@lumine-code/etch");

// Etch holds its scheduler per copy of the library, and this package resolves
// its own copy — so the assignment the editor makes on core's copy never
// reaches it. Point it at the view registry before anything renders, or this
// package's DOM writes land on an animation frame of their own alongside the
// editor's and force a synchronous reflow.
etch.setScheduler(lumine.views);

const WATCHES_URI = "lumine://jupyter-watches";

let subscriptions = null;
let session = null;
let pane = null;

function initialPackageBatchPending() {
  const packages = lumine.packages;
  return Boolean(
    packages?.activatePromise ||
    (packages?.hasLoadedInitialPackages?.() && !packages?.hasActivatedInitialPackages?.()),
  );
}

// Workspace deserialization precedes initial package activation. Build the
// session in Lumine's pre-activation hook so the restored pane and the later
// command/service registrations keep talking to the same object.
function initialize() {
  session ??= new WatchesSession();
}

function activate() {
  initialize();
  subscriptions = new CompositeDisposable(
    lumine.commands.add("lumine-workspace", {
      "jupyter-watches:toggle": () => lumine.workspace.toggle(WATCHES_URI),
      "jupyter-watches:toggle-focus": () => toggleFocus(),
      // Packages > Jupyter Watches > Watch Selection dispatches at whatever
      // holds focus, so an editor scope left it dead off-editor. addWatch reads
      // the focused editor from the provider rather than the dispatch target,
      // so nothing else has to change.
      "jupyter-watches:add": {
        description: "Watch the expression under the cursor as the kernel runs.",
        didDispatch: () => addWatch(),
      },
    }),
    // remove acts on the watch editor it was dispatched from, so it stays where
    // that editor is and is not in a menu.
    lumine.commands.add("lumine-text-editor:not([mini])", {
      "jupyter-watches:remove": {
        description: "Stop watching the selected expression.",
        didDispatch: (event) => removeWatch(event),
      },
    }),
    lumine.workspace.addOpener((uri) => (uri === WATCHES_URI ? getPane() : undefined)),
    new Disposable(() => destroyPane()),
    new Disposable(() => {
      session?.destroy();
      session = null;
    }),
  );
}

// Reveal and focus the pane, or hand focus back to the centre when it already
// has it. This is what the keystroke binds rather than `toggle`: pressing it a
// second time should return you to your work, not hide a pane you are looking
// at. jupyter-monitor and jupyter-inspector use the same shape.
async function toggleFocus() {
  const element = lumine.workspace.paneForURI(WATCHES_URI)?.element;
  const isFocused =
    element &&
    (element.offsetWidth !== 0 || element.offsetHeight !== 0) &&
    element.contains(document.activeElement);

  if (isFocused) {
    lumine.workspace.getCenter().activate();
    return;
  }

  const item = await lumine.workspace.open(WATCHES_URI, { searchAllPanes: true });
  item?.focus?.();
}

function deactivate() {
  subscriptions?.dispose();
  subscriptions = null;
  // Cover a pane restored before activation even if startup is interrupted.
  destroyPane();
  session?.destroy();
  session = null;
}

function consumeJupyterKernel(provider) {
  let disposed = false;
  const connect = () => {
    if (!disposed) session.setProvider(provider);
  };
  if (initialPackageBatchPending()) queueMicrotask(connect);
  else connect();
  return new Disposable(() => {
    disposed = true;
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

function adoptPane(item) {
  pane = item;
  item.onDidDestroy(() => {
    if (pane === item) {
      pane = null;
    }
  });
  return item;
}

function getPane() {
  initialize();
  if (pane && !pane.destroyed) {
    return pane;
  }

  const existing = lumine.workspace.getPaneItems().find((item) => item.getURI?.() === WATCHES_URI);
  if (existing) {
    return adoptPane(existing);
  }

  const WatchesPane = require("./watches-pane");
  return adoptPane(new WatchesPane(session));
}

function destroyPane() {
  const items = lumine.workspace.getPaneItems().filter((item) => item.getURI?.() === WATCHES_URI);
  if (pane && !items.includes(pane)) {
    items.push(pane);
  }
  for (const item of items) {
    item.destroy();
  }
  pane = null;
}

function deserializeWatchesPane() {
  return getPane();
}

/**
 * Watch the editor's selection, or add an empty watch to type into. The
 * focused editor comes from the provider, so a notebook's cell editors —
 * which the workspace does not report — are found too.
 */
async function addWatch() {
  const store = session.storeFor();
  if (!store) {
    lumine.notifications.addWarning("jupyter-watches", {
      description: "No running kernel to watch on.",
    });
    return;
  }

  store.addWatchFromEditor(session.provider?.getFocusedEditor?.());
  await lumine.workspace.open(WATCHES_URI, { searchAllPanes: true, activatePane: false });
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
  initialize,
  activate,
  deactivate,
  deserializeWatchesPane,
  consumeJupyterKernel,
  consumeJupyterOutput,
  consumeAutocompleteWatchEditor,
  WATCHES_URI,
  // The specs drive the session directly; nothing else should reach for it.
  getSession: () => session,
};
