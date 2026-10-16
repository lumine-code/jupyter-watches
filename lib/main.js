const { CompositeDisposable, Disposable } = require("lumine");
const WatchesSession = require("./watches-session");
const { autocompleteConsumer } = require("./autocomplete");

const WATCHES_URI = "lumine://jupyter-watches";

let subscriptions = null;
let lifecycleGeneration = 0;
let context = null;
let connections = createConnections();
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
    session.onDidChangeCurrentKernel(() => lumine.commands.invalidateAvailability()),
    lumine.commands.add("lumine-workspace", {
      "jupyter-watches:toggle": () => lumine.workspace.toggle(WATCHES_URI),
      "jupyter-watches:toggle-focus": () => toggleFocus(),
    }),
    lumine.commands.add("lumine-text-editor:not([mini])", {
      "jupyter-watches:add": {
        description: "Watch the expression under the cursor as the kernel runs.",
        isAvailable: (event) => {
          const editor = lumine.workspace.getTextEditorForElement(event?.target, {
            includeMini: false,
          });
          return Boolean(
            editor &&
            session?.provider?.peekKernelState?.({
              item: event.context?.item ?? editor,
              editor,
              window: event.context?.window,
            }),
          );
        },
        didDispatch: (event) => addWatch(event),
      },
    }),
    // remove acts on the watch editor it was dispatched from, so it stays where
    // that editor is and is not in a menu.
    lumine.commands.add("lumine-text-editor.watch-input:not([mini])", {
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
  const generation = lifecycleGeneration;
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
  if (generation !== lifecycleGeneration) return;
  item?.focus?.();
}

function deactivate() {
  lifecycleGeneration++;
  subscriptions?.dispose();
  subscriptions = null;
  context = null;
  for (const state of Object.values(connections)) {
    for (const edge of state.edges) edge.payload = null;
    state.edges.clear();
  }
  connections = createConnections();
  // Cover a pane restored before activation even if startup is interrupted.
  destroyPane();
  session?.destroy();
  session = null;
  autocompleteConsumer.revoke();
}

function createConnections() {
  return Object.fromEntries(
    ["context", "kernel", "output"].map((kind) => [kind, { edges: new Set(), revision: 0 }]),
  );
}

function consumeConnection(kind, payload, apply) {
  const state = connections[kind];
  const edge = { payload };
  state.edges.add(edge);
  const refresh = () => {
    if (connections[kind] !== state) return;
    const revision = ++state.revision;
    const current = () => connections[kind] === state && state.revision === revision;
    apply(Array.from(state.edges).at(-1)?.payload ?? null, current);
  };
  refresh();
  return new Disposable(() => {
    state.edges.delete(edge);
    edge.payload = null;
    refresh();
  });
}

function consumeJupyterContext(service) {
  return consumeConnection("context", service, (next) => {
    context = next;
  });
}

function consumeJupyterKernel(provider) {
  initialize();
  const connectedSession = session;
  return consumeConnection("kernel", provider, (next, current) => {
    const connect = () => {
      if (!current() || session !== connectedSession) return;
      connectedSession.setProvider(next);
      if (!next) destroyPane();
    };
    if (next && initialPackageBatchPending()) queueMicrotask(connect);
    else connect();
  });
}

function consumeJupyterOutput(service) {
  initialize();
  const connectedSession = session;
  return consumeConnection("output", service, (next) => {
    if (session === connectedSession) connectedSession.setOutputService(next);
  });
}

function consumeAutocompleteWatchEditor(service) {
  return autocompleteConsumer.consume(service);
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

  require("@lumine-code/etch").setScheduler(lumine.views);
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
 * focused editor comes from the context service, so a notebook's cell editors —
 * which the workspace does not report — are found too.
 */
async function addWatch(event) {
  const editor =
    context?.getFocusedEditor(event) ??
    lumine.workspace.getTextEditorForElement(event?.target, { includeMini: false });
  if (!editor) return;
  const kernel = session.provider?.getKernelForEditor(editor);
  const store = session.storeFor(kernel);
  if (!store) {
    lumine.notifications.addWarning("jupyter-watches", {
      description: "No running kernel to watch on.",
    });
    return;
  }

  session.setKernel(kernel);
  store.addWatchFromEditor(editor);
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
  provideMcpTools() {
    return require("./mcp-tools").createTools(() => session);
  },
  provideBackgroundTips() {
    return {
      packageName: "jupyter-watches",
      tips: [
        "You can watch the selected expression re-evaluate after every run with {{ 'jupyter-watches:add' | keystroke }}",
      ],
    };
  },

  initialize,
  activate,
  deactivate,
  deserializeWatchesPane,
  consumeJupyterKernel,
  consumeJupyterContext,
  consumeJupyterOutput,
  consumeAutocompleteWatchEditor,
  WATCHES_URI,
  // The specs drive the session directly; nothing else should reach for it.
  getSession: () => session,
};
