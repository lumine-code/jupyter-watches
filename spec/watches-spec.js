const { recordRequest, settle, createOutputAccumulator } = require("./request-fixture");
const etch = require("@lumine-code/etch");
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
    grammar: {
      name: "Python",
      scopeName: "source.python",
    },
    executed: [],
    idleCallbacks: [],
    request(specification) {
      return recordRequest(this, specification);
    },
    onDidBecomeIdle(callback) {
      this.idleCallbacks.push(callback);
      return {
        dispose: () => this.idleCallbacks.splice(this.idleCallbacks.indexOf(callback), 1),
      };
    },
    generation: 0,
    onDidChangeGeneration: () => ({
      dispose() {},
    }),
  };
}
function fakeProvider(kernel = null) {
  const listeners = {
    kernel: [],
    removed: [],
  };
  return {
    listeners,
    getActiveKernel: () => kernel,
    onDidChangeKernel(callback) {
      listeners.kernel.push(callback);
      return {
        dispose: () => {},
      };
    },
    onDidRemoveKernel(callback) {
      listeners.removed.push(callback);
      return {
        dispose: () => {},
      };
    },
  };
}
function fakeOutputService() {
  return {
    createOutputAccumulator,
    normalizeOutput: (output) => output,
    renderDisplay: (output) =>
      etch.dom("pre", {}, output.text || output.data?.["text/plain"] || ""),
  };
}
describe("watch store", () => {
  let kernel;
  let watch;
  beforeEach(() => {
    kernel = fakeKernel();
    watch = new WatchStore(kernel, createOutputAccumulator);
  });
  afterEach(() => {
    watch?.destroy();
    watch = null;
  });
  it("does nothing until it is watching", async () => {
    watch.setCode("df.shape");
    await settle();
    watch.run();
    await settle();
    expect(kernel.executed).toEqual([]);
  });
  it("runs through the kernel's watch lane once started", async () => {
    watch.setCode("df.shape");
    await settle();
    watch.toggleWatching();
    await settle();
    expect(kernel.executed).toEqual(["df.shape"]);
  });
  it("records each result under the run that produced it", async () => {
    watch.setCode("df.shape");
    await settle();
    watch.toggleWatching();
    await settle();
    kernel.lastOnResults({
      output_type: "stream",
      name: "stdout",
      text: "(3, 2)",
    });
    await settle();
    kernel.lastOnResults({
      output_type: "status",
      execution_state: "idle",
    });
    await settle();
    expect(watch.outputStore.runs).toBe(1);
    expect(watch.outputStore.outputs.length).toBe(1);
    watch.run();
    await settle();
    kernel.lastOnResults({
      output_type: "stream",
      name: "stdout",
      text: "(4, 2)",
    });
    await settle();
    kernel.lastOnResults({
      output_type: "status",
      execution_state: "idle",
    });
    await settle();
    expect(watch.outputStore.runs).toBe(2);
    expect(watch.outputStore.outputs.length).toBe(2);
  });
  it("drops a re-run while the previous one is still outstanding", async () => {
    // The idle signal is kernel-wide, so a chatty client can ask for re-runs
    // faster than the expression evaluates. Only one may be in flight; the
    // next idle after completion runs again.
    watch.setCode("df.shape");
    await settle();
    watch.toggleWatching();
    await settle();
    watch.run();
    await settle();
    expect(kernel.executed).toEqual(["df.shape"]);
    kernel.lastOnResults({
      output_type: "status",
      execution_state: "idle",
    });
    await settle();
    watch.run();
    await settle();
    expect(kernel.executed).toEqual(["df.shape", "df.shape"]);
  });
  it("releases a run the kernel answers with an error", async () => {
    // A restart or a dead process settles an outstanding watch with an error
    // output; the next idle must run again rather than stay latched.
    watch.setCode("df.shape");
    await settle();
    watch.toggleWatching();
    await settle();
    expect(kernel.executed).toEqual(["df.shape"]);
    kernel.lastOnResults({
      output_type: "error",
      ename: "ExecutionAborted",
      evalue: "Kernel restarted",
      traceback: [],
    });
    await settle();
    watch.run();
    await settle();
    expect(kernel.executed).toEqual(["df.shape", "df.shape"]);
  });
  it("keeps its expression model independent of a view editor", async () => {
    watch.setCode("value");
    expect(watch.editor).toBeUndefined();
    expect(watch.getCode()).toBe("value");
    expect(lumine.workspace.getTextEditors()).not.toContain(watch);
  });
  it("drops output that arrives after its watch is destroyed", async () => {
    watch.setCode("value");
    await settle();
    watch.toggleWatching();
    await settle();
    const deliver = kernel.lastOnResults;
    watch.destroy();
    await settle();
    deliver({
      output_type: "stream",
      name: "stdout",
      text: "late value",
    });
    await settle();
    expect(watch.outputStore.outputs).toEqual([]);
  });
  it("drops an earlier request's late output after a new run starts", async () => {
    watch.setCode("value");
    await settle();
    watch.toggleWatching();
    await settle();
    const earlier = kernel.lastOnResults;
    earlier({
      output_type: "error",
      ename: "KernelGone",
      evalue: "Restarting",
    });
    await settle();
    watch.run();
    await settle();
    const count = watch.outputStore.outputs.length;
    earlier({
      output_type: "stream",
      name: "stdout",
      text: "late value",
    });
    await settle();
    expect(watch.outputStore.outputs.length).toBe(count);
    expect(watch._running).toBe(true);
  });
  it("settles a run whose kernel wrapper throws synchronously", async () => {
    kernel.request = () => {
      throw new Error("Kernel restarted");
    };
    watch.setCode("value");
    await settle();
    expect(() => watch.toggleWatching()).not.toThrow();
    expect(watch._running).toBe(false);
    expect(watch.outputStore.outputs[0].evalue).toBe("Kernel restarted");
  });
});
describe("watches store", () => {
  let kernel;
  let store;
  beforeEach(() => {
    kernel = fakeKernel();
    store = new WatchesStore(kernel, createOutputAccumulator);
  });
  afterEach(() => {
    store?.destroy();
    store = null;
  });
  it("re-runs every watching watch when the kernel falls idle", async () => {
    const watching = store.createWatch();
    watching.setCode("a");
    await settle();
    watching.toggleWatching();
    // Complete the run toggleWatching started, as a real kernel would.
    await settle();
    kernel.lastOnResults({
      output_type: "status",
      execution_state: "idle",
    });
    await settle();
    const paused = store.createWatch();
    paused.setCode("b");
    await settle();
    kernel.executed.length = 0;
    expect(kernel.idleCallbacks.length).toBe(1);
    kernel.idleCallbacks[0]();
    await settle();
    expect(kernel.executed).toEqual(["a"]);
  });
  it("reuses the last watch while it is still empty", async () => {
    const first = store.createWatch();
    expect(store.createWatch()).toBe(first);
    first.setCode("df");
    await settle();
    expect(store.createWatch()).not.toBe(first);
  });
  it("starts watching a selection handed over from an editor", async () => {
    store.addWatchFromEditor({
      getSelectedText: () => "df.head()",
    });
    await settle();
    expect(store.watches.length).toBe(1);
    expect(store.watches[0].getCode()).toBe("df.head()");
    expect(store.watches[0].isWatching).toBe(true);
    expect(kernel.executed).toEqual(["df.head()"]);
  });
  it("finds and removes a watch by its editor", async () => {
    const watch = store.createWatch();
    const editor = {};
    const edge = store.registerEditor(watch, editor);
    expect(store.removeWatchForEditor(editor)).toBe(true);
    expect(store.watches.length).toBe(0);
    expect(watch.destroyed).toBe(true);
    edge.dispose();
    expect(store.editors.size).toBe(0);
  });
  it("lets go of the idle hook when destroyed", async () => {
    expect(kernel.idleCallbacks.length).toBe(1);
    store.destroy();
    await settle();
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
  it("keeps one store per kernel", async () => {
    const first = fakeKernel();
    const second = fakeKernel();
    session.setProvider(fakeProvider(first));
    await settle();
    const store = session.storeFor();
    expect(session.storeFor()).toBe(store);
    expect(session.storeFor(second)).not.toBe(store);
  });
  it("keeps watch models available without a renderer", async () => {
    session.setOutputService(null);
    session.setProvider(fakeProvider(fakeKernel()));
    expect(session.storeFor()).not.toBeNull();
  });
  it("drops the store of a kernel that goes away", async () => {
    const kernel = fakeKernel();
    const provider = fakeProvider(kernel);
    session.setProvider(provider);
    await settle();
    session.storeFor();
    await settle();
    expect(kernel.idleCallbacks.length).toBe(1);
    provider.listeners.removed[0](kernel);
    await settle();
    expect(session.kernel).toBe(null);
    expect(kernel.idleCallbacks.length).toBe(0);
  });
  it("releases old models and idle hooks when its kernel provider detaches", async () => {
    const kernel = fakeKernel();
    session.setProvider(fakeProvider(kernel));
    const store = session.storeFor();
    const watch = store.createWatch();
    session.setProvider(null);
    expect(session.stores.size).toBe(0);
    expect(watch.destroyed).toBe(true);
    expect(kernel.idleCallbacks.length).toBe(0);
  });
  it("preserves expressions and owned history across renderer removal and replacement", async () => {
    const kernel = fakeKernel();
    session.setProvider(fakeProvider(kernel));
    const original = session.storeFor();
    const watch = original.createWatch();
    watch.setCode("value");
    watch.outputStore.appendOutput({
      output_type: "stream",
      name: "stdout",
      text: "retained",
    });
    session.setOutputService(null);
    session.setOutputService(fakeOutputService());
    expect(session.storeFor()).toBe(original);
    expect(watch.getCode()).toBe("value");
    expect(watch.outputStore.outputs[0].text).toBe("retained");
    expect(watch.destroyed).not.toBe(true);
    expect(kernel.idleCallbacks.length).toBe(1);
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
    component = new Watches({
      session,
    });
    flush(component);
    return component;
  }
  it("says so when no kernel is running", async () => {
    render();
    await settle();
    expect(component.element.textContent).toContain("No kernel running");
  });
  it("renders one view per watch, each with its history", async () => {
    session.setProvider(fakeProvider(fakeKernel()));
    await settle();
    render();
    await settle();
    session.storeFor().createWatch().setCode("df");
    await settle();
    session.storeFor().createWatch();
    await settle();
    flush(component);
    await settle();
    expect(component.element.querySelectorAll(".watch-view").length).toBe(2);
    expect(component.element.querySelectorAll(".history").length).toBe(2);
  });
  it("keeps the real watch editor attached across a patch", async () => {
    session.setProvider(fakeProvider(fakeKernel()));
    await settle();
    render();
    await settle();
    session.storeFor().createWatch();
    flush(component);
    await settle();
    const attached = component.element.querySelector(".watch-editor-container lumine-text-editor");
    expect(attached).toBeTruthy();
    flush(component);
    await settle();
    expect(component.element.querySelector(".watch-editor-container lumine-text-editor")).toBe(
      attached,
    );
  });
});
describe("watches pane teardown", () => {
  // A pane drops an item only when the item tells it so; losing a service
  // destroys the item directly rather than through `pane.destroyItem`.
  it("leaves no tab behind when destroyed directly", async () => {
    const session = new WatchesSession();
    const item = new WatchesPane(session);
    const pane = lumine.workspace.getCenter().getActivePane();
    pane.addItem(item);
    await settle();
    expect(pane.getItems()).toContain(item);
    item.destroy();
    await settle();
    expect(pane.getItems()).not.toContain(item);
    session.destroy();
    await settle();
  });
  it("survives being destroyed twice", async () => {
    const session = new WatchesSession();
    const item = new WatchesPane(session);
    item.destroy();
    await settle();
    expect(() => item.destroy()).not.toThrow();
    session.destroy();
    await settle();
  });
});
