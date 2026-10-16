const { Disposable } = require("lumine");
const { recordRequest, createOutputAccumulator } = require("./request-fixture");
describe("jupyter-watches surviving service connections", () => {
  let editor, pane, leases, kernel;
  const flush = () =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    spyOn(lumine.clipboard, "write");
    leases = [];
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("jupyter-watches");
    editor = await lumine.workspace.open();
    editor.setText("value");
    editor.selectAll();
    kernel = makeKernel("owned");
  });
  afterEach(async () => {
    for (const lease of leases) lease.dispose();
    pane?.destroy();
    editor?.destroy();
    if (lumine.packages.isPackageLoaded("jupyter-watches"))
      await lumine.packages.unloadPackage("jupyter-watches");
    await lumine.fileWatchClient.settlePendingTeardown();
  });
  function makeKernel(name) {
    return {
      id: name,
      generation: 0,
      language: "javascript",
      grammar: lumine.grammars.nullGrammar,
      requests: [],
      request(specification) {
        return recordRequest(this, specification);
      },
      onDidChangeGeneration: () => new Disposable(),
      onDidBecomeIdle: () => new Disposable(),
    };
  }
  function provider(target = kernel) {
    return {
      getActiveKernel: () => target,
      getKernelForEditor: () => target,
      peekKernelState: () => ({ language: target.language }),
      onDidChangeKernel: () => new Disposable(),
      onDidRemoveKernel: () => new Disposable(),
    };
  }
  function context() {
    return {
      getFocusedEditor: (event) =>
        event?.target?.closest?.("lumine-text-editor")?.getModel?.() || editor,
      getExpressionAtCursor: (target) => target.getSelectedText(),
    };
  }
  function output(prefix) {
    const etch = require("@lumine-code/etch");
    return {
      createOutputAccumulator,
      truncateOutput: (text) => ({ text, truncated: false }),
      ansiNodes: (text) => prefix + text,
      normalizeOutput: (value) => value,
      renderDisplay: (value) => etch.dom("pre", {}, prefix + (value.text || "")),
    };
  }
  function provide(name, payload) {
    const lease = lumine.packages.serviceHub.provide(name, "1.0.0", payload);
    leases.push(lease);
    return lease;
  }
  async function run(target = kernel) {
    const previous = target.requests.length;
    await lumine.commands.dispatch(editor.element, "jupyter-watches:add");
    await flush();
    const request = target.requests[previous];
    expect(request?.specification.code).toBe("value");
    if (request) {
      request.receive({ output_type: "stream", name: "stdout", text: "docs" });
      request.finish();
    }
    await flush();
    pane = lumine.workspace
      .paneForURI("lumine://jupyter-watches")
      ?.getItems()
      .find((item) => item.getURI?.() === "lumine://jupyter-watches");
    expect(pane?.element.textContent).toContain("docs");
    return pane;
  }
  it("retains the shared kernel provider after its newest connection retires", async () => {
    const service = provider();
    provide("jupyter.kernel", service);
    const latest = provide("jupyter.kernel", service);
    provide("jupyter.context", context());
    await run();
    latest.dispose();
    await flush();
    await run();
  });
  it("restores the surviving kernel provider after its replacement retires", async () => {
    provide("jupyter.kernel", provider());
    const other = makeKernel("other");
    const latest = provide("jupyter.kernel", provider(other));
    provide("jupyter.context", context());
    await run(other);
    latest.dispose();
    await flush();
    await run();
  });
  it("retains the shared renderer for the actual displayed result", async () => {
    provide("jupyter.kernel", provider());
    provide("jupyter.context", context());
    const service = output("shared:");
    provide("jupyter.output", service);
    const latest = provide("jupyter.output", service);
    await run();
    latest.dispose();
    await flush();
    expect(pane.element.textContent).toContain("shared:docs");
  });
  it("restores the surviving renderer for the actual displayed result", async () => {
    provide("jupyter.kernel", provider());
    provide("jupyter.context", context());
    provide("jupyter.output", output("first:"));
    const latest = provide("jupyter.output", output("second:"));
    await run();
    expect(pane.element.textContent).toContain("second:docs");
    latest.dispose();
    await flush();
    expect(pane.element.textContent).toContain("first:docs");
  });
  it("retains the real command editor's context after its newest shared connection retires", async () => {
    provide("jupyter.kernel", provider());
    const service = context();
    provide("jupyter.context", service);
    const latest = provide("jupyter.context", service);
    latest.dispose();
    await run();
  });
  it("keeps ordinary latest live providers and their actual command results", async () => {
    const first = provide("jupyter.kernel", provider(makeKernel("previous")));
    provide("jupyter.kernel", provider());
    provide("jupyter.context", context());
    provide("jupyter.output", output("live:"));
    first.dispose();
    await run();
    expect(pane.element.textContent).toContain("live:docs");
  });
});
