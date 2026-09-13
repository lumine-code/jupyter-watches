const path = require("path");
const manifest = require("../package.json");
const main = require("../lib/main");
const WatchesSession = require("../lib/watches-session");
const WatchesPane = require("../lib/watches-pane");

const DESERIALIZER = "jupyter-watches/WatchesPane";

function fakeKernel() {
  return {
    displayName: "Python 3",
    language: "python",
    grammar: { name: "Python", scopeName: "source.python" },
    onDidBecomeIdle: () => ({ dispose() {} }),
  };
}

function fakeProvider(kernel) {
  let disposedSubscriptions = 0;
  return {
    get disposedSubscriptions() {
      return disposedSubscriptions;
    },
    getActiveKernel: () => kernel,
    getFocusedEditor: () => null,
    onDidChangeKernel: () => ({ dispose: () => disposedSubscriptions++ }),
    onDidRemoveKernel: () => ({ dispose: () => disposedSubscriptions++ }),
  };
}

function fakeOutputService() {
  return {
    OutputStore: class {},
    History: class {},
  };
}

// A restored dock item is deserialized before the package's activation and
// consumed services. Its session must therefore exist early and survive the
// subsequent activate() call.
describe("restoring the Watches pane", () => {
  let loadedPackage = null;

  afterEach(async () => {
    if (loadedPackage && lumine.packages.isPackageActive(loadedPackage.name)) {
      await lumine.packages.deactivatePackage(loadedPackage.name);
    } else {
      main.deactivate();
    }
    if (loadedPackage && lumine.packages.isPackageLoaded(loadedPackage.name)) {
      lumine.packages.unloadPackage(loadedPackage.name);
    }
    loadedPackage = null;
  });

  it("declares the deserializer method named by its serialized state", () => {
    expect(manifest.deserializers[DESERIALIZER]).toBe("deserializeWatchesPane");
    expect(typeof main.deserializeWatchesPane).toBe("function");
  });

  it("serializes only the pane's identity", () => {
    main.initialize();
    const item = main.deserializeWatchesPane();

    expect(item.serialize()).toEqual({ deserializer: DESERIALIZER });
    expect(item.getDefaultLocation()).toBe("right");
    expect(item.getAllowedLocations()).toEqual(["right", "left"]);
  });

  it("round-trips through the manifest-registered proxy before activation", () => {
    const sourceSession = new WatchesSession();
    const source = new WatchesPane(sourceSession);
    const state = source.serialize();
    source.destroy();
    sourceSession.destroy();

    spyOn(lumine.packages, "hasActivatedInitialPackages").and.returnValue(false);
    loadedPackage = lumine.packages.loadPackage(path.resolve(__dirname, ".."));

    const restored = lumine.deserializers.deserialize(state);

    expect(restored).toBeTruthy();
    expect(restored.serialize()).toEqual(state);
    expect(restored.component.session).toBe(main.getSession());
    expect(loadedPackage.mainInitialized).toBe(true);
    expect(loadedPackage.mainActivated).toBe(false);
  });

  it("keeps the restored pane and its session when activation follows", () => {
    main.initialize();
    const restored = main.deserializeWatchesPane();
    const initializedSession = main.getSession();

    main.activate();

    expect(main.getSession()).toBe(initializedSession);
    expect(restored.component.session).toBe(initializedSession);
    expect(main.deserializeWatchesPane()).toBe(restored);
  });

  it("wires late kernel and output services into the restored session", async () => {
    main.initialize();
    const restored = main.deserializeWatchesPane();
    const initializedSession = main.getSession();
    main.activate();
    expect(await lumine.workspace.open(main.WATCHES_URI, { searchAllPanes: true })).toBe(restored);

    const kernel = fakeKernel();
    const provider = fakeProvider(kernel);
    const outputService = fakeOutputService();
    const kernelConnection = main.consumeJupyterKernel(provider);
    const outputConnection = main.consumeJupyterOutput(outputService);

    expect(main.getSession()).toBe(initializedSession);
    expect(restored.component.session).toBe(initializedSession);
    expect(initializedSession.provider).toBe(provider);
    expect(initializedSession.outputService).toBe(outputService);
    expect(initializedSession.storeFor().kernel).toBe(kernel);

    outputConnection.dispose();

    expect(restored.destroyed).toBe(true);
    expect(lumine.workspace.getPaneItems()).not.toContain(restored);
    kernelConnection.dispose();
    expect(provider.disposedSubscriptions).toBe(2);
  });

  it("removes a restored tab when the late kernel provider goes away", async () => {
    main.initialize();
    const restored = main.deserializeWatchesPane();
    main.activate();
    expect(await lumine.workspace.open(main.WATCHES_URI, { searchAllPanes: true })).toBe(restored);

    const provider = fakeProvider(fakeKernel());
    const kernelConnection = main.consumeJupyterKernel(provider);
    const outputConnection = main.consumeJupyterOutput(fakeOutputService());

    kernelConnection.dispose();

    expect(provider.disposedSubscriptions).toBe(2);
    expect(restored.destroyed).toBe(true);
    expect(lumine.workspace.getPaneItems()).not.toContain(restored);
    outputConnection.dispose();
  });

  it("creates a new singleton after the restored pane is closed", () => {
    main.initialize();
    const first = main.deserializeWatchesPane();

    first.destroy();

    expect(main.deserializeWatchesPane()).not.toBe(first);
  });

  it("destroys the restored component and session once on deactivation", () => {
    main.initialize();
    const item = main.deserializeWatchesPane();
    const session = main.getSession();
    spyOn(item.component, "destroy").and.callThrough();
    spyOn(session, "destroy").and.callThrough();
    main.activate();

    main.deactivate();

    expect(item.component.destroy).toHaveBeenCalledTimes(1);
    expect(session.destroy).toHaveBeenCalledTimes(1);
  });
});
