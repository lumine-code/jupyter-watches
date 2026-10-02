const { Disposable } = require("lumine");

describe("watches service replacement", () => {
  let main;
  beforeEach(() => {
    main = require("../lib/main");
    main.initialize();
    main.activate();
  });
  afterEach(() => main.deactivate());

  function provider() {
    return {
      getActiveKernel: () => null,
      onDidChangeKernel: () => new Disposable(),
      onDidRemoveKernel: () => new Disposable(),
    };
  }

  it("keeps the newer kernel provider when the old one detaches", async () => {
    const pane = main.deserializeWatchesPane();
    const original = main.consumeJupyterKernel(provider());
    const next = provider();
    const replacement = main.consumeJupyterKernel(next);
    await Promise.resolve();
    original.dispose();
    expect(pane.destroyed).not.toBe(true);
    expect(main.getSession().provider).toBe(next);
    replacement.dispose();
    expect(pane.destroyed).toBe(true);
  });

  it("keeps the newer output service when the old one detaches", () => {
    const pane = main.deserializeWatchesPane();
    const original = main.consumeJupyterOutput({});
    const next = {};
    const replacement = main.consumeJupyterOutput(next);
    original.dispose();
    expect(pane.destroyed).not.toBe(true);
    expect(main.getSession().outputService).toBe(next);
    replacement.dispose();
    expect(pane.destroyed).toBe(true);
  });
});
