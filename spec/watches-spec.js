const etch = require("@lumine-code/etch");
const { Emitter } = require("lumine");
const { WatchStore } = require("../lib/watch-store");
const WatchesStore = require("../lib/watches-store");
const WatchesSession = require("../lib/watches-session");
const Watches = require("../lib/watches");
const WatchesPane = require("../lib/watches-pane");

// This panel used to live inside jupyter-repl and hang its stores off the
// internal Kernel objects. It only ever sees the service surfaces now, so the
// fakes below offer exactly what the contracts document and nothing else.

const flush = (component) => etch.updateSync(component);

function fakeKernel() {
  return {
    displayName: "Python 3",
    language: "python",
    grammar: { name: "Python", scopeName: "source.python" },
    executed: [],
    idleCallbacks: [],
    executeWatch(code, onResults) {
      this.executed.push(code);
      this.lastOnResults = onResults;
    },
    onDidBecomeIdle(callback) {
      this.idleCallbacks.push(callback);
      return {
        dispose: () => this.idleCallbacks.splice(this.idleCallbacks.indexOf(callback), 1),
      };
    },
  };
}

function fakeProvider(kernel = null) {
  const listeners = { kernel: [], removed: [] };
  return {
    listeners,
    getActiveKernel: () => kernel,
    getFocusedEditor: () => null,
    onDidChangeKernel(callback) {
      listeners.kernel.push(callback);
      return { dispose: () => {} };
    },
    onDidRemoveKernel(callback) {
      listeners.removed.push(callback);
      return { dispose: () => {} };
    },
  };
}

// The output service, as far as this package touches it: an OutputStore with
// run boundaries, and a History component taking { store }.
class FakeOutputStore {
  constructor(maxOutputs) {
    this.maxOutputs = maxOutputs;
    this.emitter = new Emitter();
    this.outputs = [];
    this.runs = 0;
  }
  onDidUpdate(callback) {
    return this.emitter.on("did-update", callback);
  }
  startNewRun() {
    this.runs++;
  }
  appendOutput(message) {
    // Mirrors the real store: a status message updates lifecycle state but
    // never becomes an output entry.
    if (message.output_type === "status") return;
    this.outputs.push(message);
    this.emitter.emit("did-update");
  }
  clear() {
    this.outputs = [];
    this.emitter.emit("did-update");
  }
}

class FakeHistory {
  constructor({ store }) {
    this.store = store;
    etch.initialize(this);
  }
  render() {
    return etch.dom("div", { className: "fake-history" }, String(this.store.outputs.length));
  }
  update() {
    return etch.update(this);
  }
  destroy() {
    return etch.destroy(this);
  }
}

function fakeOutputService() {
  return { OutputStore: FakeOutputStore, History: FakeHistory };
}

describe("watch store", () => {
  let kernel;
  let watch;

  beforeEach(() => {
    kernel = fakeKernel();
    watch = new WatchStore(kernel, fakeOutputService());
  });

  afterEach(() => {
    watch?.destroy();
    watch = null;
  });

  it("does nothing until it is watching", () => {
    watch.setCode("df.shape");
    watch.run();

    expect(kernel.executed).toEqual([]);
  });

  it("runs through the kernel's watch lane once started", () => {
    watch.setCode("df.shape");
    watch.toggleWatching();

    expect(kernel.executed).toEqual(["df.shape"]);
  });

  it("records each result under the run that produced it", () => {
    watch.setCode("df.shape");
    watch.toggleWatching();
    kernel.lastOnResults({ output_type: "stream", name: "stdout", text: "(3, 2)" });
    kernel.lastOnResults({ output_type: "status", execution_state: "idle" });

    expect(watch.outputStore.runs).toBe(1);
    expect(watch.outputStore.outputs.length).toBe(1);

    watch.run();
    kernel.lastOnResults({ output_type: "stream", name: "stdout", text: "(4, 2)" });
    kernel.lastOnResults({ output_type: "status", execution_state: "idle" });

    expect(watch.outputStore.runs).toBe(2);
    expect(watch.outputStore.outputs.length).toBe(2);
  });

  it("drops a re-run while the previous one is still outstanding", () => {
    // The idle signal is kernel-wide, so a chatty client can ask for re-runs
    // faster than the expression evaluates. Only one may be in flight; the
    // next idle after completion runs again.
    watch.setCode("df.shape");
    watch.toggleWatching();

    watch.run();
    expect(kernel.executed).toEqual(["df.shape"]);

    kernel.lastOnResults({ output_type: "status", execution_state: "idle" });
    watch.run();
    expect(kernel.executed).toEqual(["df.shape", "df.shape"]);
  });

  it("releases a run the kernel answers with an error", () => {
    // A restart or a dead process settles an outstanding watch with an error
    // output; the next idle must run again rather than stay latched.
    watch.setCode("df.shape");
    watch.toggleWatching();
    expect(kernel.executed).toEqual(["df.shape"]);

    kernel.lastOnResults({
      output_type: "error",
      ename: "ExecutionAborted",
      evalue: "Kernel restarted",
      traceback: [],
    });
    watch.run();

    expect(kernel.executed).toEqual(["df.shape", "df.shape"]);
  });

  it("owns a real editor carrying the kernel's grammar class", () => {
    expect(watch.editor.element.classList.contains("watch-input")).toBe(true);

    const editor = watch.editor;
    watch.destroy();
    watch = null;
    expect(editor.isDestroyed()).toBe(true);
  });
});

describe("watches store", () => {
  let kernel;
  let store;

  beforeEach(() => {
    kernel = fakeKernel();
    store = new WatchesStore(kernel, fakeOutputService());
  });

  afterEach(() => {
    store?.destroy();
    store = null;
  });

  it("re-runs every watching watch when the kernel falls idle", () => {
    const watching = store.createWatch();
    watching.setCode("a");
    watching.toggleWatching();
    // Complete the run toggleWatching started, as a real kernel would.
    kernel.lastOnResults({ output_type: "status", execution_state: "idle" });

    const paused = store.createWatch();
    paused.setCode("b");

    kernel.executed.length = 0;
    expect(kernel.idleCallbacks.length).toBe(1);
    kernel.idleCallbacks[0]();

    expect(kernel.executed).toEqual(["a"]);
  });

  it("reuses the last watch while it is still empty", () => {
    const first = store.createWatch();
    expect(store.createWatch()).toBe(first);

    first.setCode("df");
    expect(store.createWatch()).not.toBe(first);
  });

  it("starts watching a selection handed over from an editor", () => {
    store.addWatchFromEditor({ getSelectedText: () => "df.head()" });

    expect(store.watches.length).toBe(1);
    expect(store.watches[0].getCode()).toBe("df.head()");
    expect(store.watches[0].isWatching).toBe(true);
    expect(kernel.executed).toEqual(["df.head()"]);
  });

  it("finds and removes a watch by its editor", () => {
    const watch = store.createWatch();
    const editor = watch.editor;

    expect(store.removeWatchForEditor(editor)).toBe(true);
    expect(store.watches.length).toBe(0);
    expect(editor.isDestroyed()).toBe(true);
  });

  it("lets go of the idle hook when destroyed", () => {
    expect(kernel.idleCallbacks.length).toBe(1);

    store.destroy();
    store = null;

    expect(kernel.idleCallbacks.length).toBe(0);
  });
});

describe("watches session", () => {
  let session;

  beforeEach(() => {
    session = new WatchesSession();
    session.setOutputService(fakeOutputService());
  });

  afterEach(() => {
    session.destroy();
  });

  it("keeps one store per kernel", () => {
    const first = fakeKernel();
    const second = fakeKernel();
    session.setProvider(fakeProvider(first));

    const store = session.storeFor();
    expect(session.storeFor()).toBe(store);
    expect(session.storeFor(second)).not.toBe(store);
  });

  it("has no store to offer without the output service", () => {
    session.setOutputService(null);
    session.setProvider(fakeProvider(fakeKernel()));

    expect(session.storeFor()).toBe(null);
  });

  it("drops the store of a kernel that goes away", () => {
    const kernel = fakeKernel();
    const provider = fakeProvider(kernel);
    session.setProvider(provider);
    session.storeFor();

    expect(kernel.idleCallbacks.length).toBe(1);

    provider.listeners.removed[0](kernel);

    expect(session.kernel).toBe(null);
    expect(kernel.idleCallbacks.length).toBe(0);
  });
});

describe("watches panel", () => {
  let component;
  let session;

  beforeEach(() => {
    session = new WatchesSession();
    session.setOutputService(fakeOutputService());
  });

  afterEach(() => {
    component?.destroy();
    component = null;
    session.destroy();
  });

  function render() {
    component = new Watches({ session });
    flush(component);
    return component;
  }

  it("says so when no kernel is running", () => {
    render();
    expect(component.element.textContent).toContain("No kernel running");
  });

  it("renders one view per watch, each with its history", () => {
    session.setProvider(fakeProvider(fakeKernel()));
    render();
    session.storeFor().createWatch().setCode("df");
    session.storeFor().createWatch();
    flush(component);

    expect(component.element.querySelectorAll(".watch-view").length).toBe(2);
    expect(component.element.querySelectorAll(".fake-history").length).toBe(2);
  });

  it("keeps the real watch editor attached across a patch", () => {
    session.setProvider(fakeProvider(fakeKernel()));
    render();
    const watch = session.storeFor().createWatch();
    flush(component);

    const attached = component.element.querySelector(".watch-editor-container lumine-text-editor");
    expect(attached).toBe(watch.editor.element);

    flush(component);
    expect(component.element.querySelector(".watch-editor-container lumine-text-editor")).toBe(
      watch.editor.element,
    );
  });
});

describe("watches pane teardown", () => {
  // A pane drops an item only when the item tells it so; losing a service
  // destroys the item directly rather than through `pane.destroyItem`.
  it("leaves no tab behind when destroyed directly", () => {
    const session = new WatchesSession();
    const item = new WatchesPane(session);
    const pane = lumine.workspace.getCenter().getActivePane();
    pane.addItem(item);

    expect(pane.getItems()).toContain(item);

    item.destroy();

    expect(pane.getItems()).not.toContain(item);
    session.destroy();
  });

  it("survives being destroyed twice", () => {
    const session = new WatchesSession();
    const item = new WatchesPane(session);
    item.destroy();
    expect(() => item.destroy()).not.toThrow();
    session.destroy();
  });
});
