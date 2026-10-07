const { recordRequest, settle, createOutputAccumulator } = require("./request-fixture");
const path = require("path");
const { Disposable } = require("lumine");
function kernel(id) {
  const requests = [];
  return {
    id,
    language: "python",
    displayName: "Python 3",
    destroyed: false,
    executionState: "idle",
    executionCount: 3,
    lastExecutionTime: "2026-10-02T10:00:00.000Z",
    requests,
    request: jasmine.createSpy("request").and.callFake(function (specification) {
      return recordRequest(this, specification);
    }),
    onDidBecomeIdle: jasmine.createSpy("idle subscription").and.callFake(() => new Disposable()),
    generation: 0,
    onDidChangeGeneration: () => ({
      dispose() {},
    }),
  };
}
function provider(kernels) {
  return {
    getActiveKernel: () => kernels[0],
    getRunningKernels: () => kernels,
    onDidChangeKernel: () => new Disposable(),
    onDidRemoveKernel: () => new Disposable(),
  };
}
function outputService() {
  return { createOutputAccumulator };
}

describe("cached watch MCP tools", () => {
  let session;
  let kernels;
  let tools;
  let maxBytes;
  beforeEach(() => {
    const WatchesSession = require("../lib/watches-session");
    const { createTools, MAX_RESPONSE_BYTES } = require("../lib/mcp-tools");
    session = new WatchesSession();
    kernels = [kernel("first"), kernel("second")];
    session.setProvider(provider(kernels));
    session.setOutputService(outputService());
    tools = Object.fromEntries(createTools(() => session).map((tool) => [tool.name, tool]));
    maxBytes = MAX_RESPONSE_BYTES;
  });
  afterEach(() => session.destroy());
  function add(source = kernels[1], code = "value") {
    const watch = session.storeFor(source).createWatch();
    watch.setCode(code);
    return watch;
  }
  function evaluate(watch, source, output) {
    if (!watch.isWatching) watch.toggleWatching();
    else watch.run();
    const request = source.requests[source.requests.length - 1];
    if (output) request.receive(output);
    request.receive({
      output_type: "status",
      execution_state: "idle",
    });
  }
  it("requires explicit IDs and does not create stores, evaluate expressions or add idle listeners", async () => {
    expect(() => tools.ListJupyterWatches.execute({})).toThrowError(/kernelId/);
    expect(
      tools.ListJupyterWatches.execute({
        kernelId: "second",
      }).status,
    ).toBe("cache-unavailable");
    expect(
      tools.ListJupyterWatches.execute({
        kernelId: "absent",
      }).status,
    ).toBe("kernel-not-found");
    expect(session.stores.size).toBe(0);
    expect(kernels[1].request).not.toHaveBeenCalled();
    expect(kernels[1].onDidBecomeIdle).not.toHaveBeenCalled();
    expect(tools.GetJupyterWatch.annotations.readOnlyHint).toBe(true);
  });
  it("gives paused watches stable IDs and does not run their expressions when read", async () => {
    add(kernels[0], "wrong");
    await settle();
    const watch = add(kernels[1], "dangerous_side_effect()");
    const first = tools.ListJupyterWatches.execute({
      kernelId: "second",
    });
    expect(first.watches.length).toBe(1);
    expect(first.watches[0].watchId).toBe(watch.id);
    expect(first.watches[0].availability).toBe("no-output");
    expect(first.watches[0].stale).toBe(null);
    const result = tools.GetJupyterWatch.execute({
      kernelId: "second",
      watchId: watch.id,
    });
    expect(result.watch.watchId).toBe(first.watches[0].watchId);
    expect(result.watch.expression).toBe("dangerous_side_effect()");
    expect(result.watch.isWatching).toBe(false);
    expect(kernels[1].request).not.toHaveBeenCalled();
  });
  it("returns detached plain snapshots, timestamps and bounded output-entry history", async () => {
    const watch = add();
    evaluate(watch, kernels[1], {
      output_type: "execute_result",
      data: {
        "text/plain": "3",
        "image/png": "binary".repeat(100000),
      },
    });
    await settle();
    evaluate(watch, kernels[1], {
      output_type: "stream",
      name: "stdout",
      text: "latest",
    });
    await settle();
    const result = tools.GetJupyterWatch.execute({
      kernelId: "second",
      watchId: watch.id,
      historyLimit: 1,
    });
    expect(result.watch.cachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.watch.stale).toBe(false);
    expect(result.watch.latest.text).toBe("latest");
    expect(result.history.length).toBe(1);
    expect(result.historyTruncated).toBe(true);
    expect(result.historyKind).toBe("output-entries");
    expect(result.historyTimestampsAvailable).toBe(false);
    result.history[0].text = "edited";
    result.watch.expression = "different";
    expect(watch.outputStore.outputs[1].text).toBe("latest");
    expect(watch.getCode()).toBe("value");
    const all = tools.GetJupyterWatch.execute({
      kernelId: "second",
      watchId: watch.id,
      historyLimit: 25,
    });
    expect(JSON.stringify(all)).not.toContain("binarybinary");
    expect(all.history[0].richDataOmitted).toBe(true);
  });
  it("marks edited, running, changed-kernel and no-new-output snapshots stale", async () => {
    const watch = add();
    evaluate(watch, kernels[1], {
      output_type: "stream",
      name: "stdout",
      text: "3",
    });
    await settle();
    const read = () =>
      tools.GetJupyterWatch.execute({
        kernelId: "second",
        watchId: watch.id,
      }).watch;
    watch.setCode("other");
    await settle();
    expect(read().stale).toBe(true);
    expect(read().evaluatedExpression).toBe("value");
    watch.setCode("value");
    await settle();
    watch.run();
    await settle();
    expect(read().stale).toBe(true);
    kernels[1].requests[kernels[1].requests.length - 1].receive({
      output_type: "status",
      execution_state: "idle",
    });
    await settle();
    expect(read().stale).toBe(true);
    evaluate(watch, kernels[1], {
      output_type: "stream",
      name: "stdout",
      text: "4",
    });
    await settle();
    kernels[1].executionCount++;
    expect(read().stale).toBe(true);
  });
  it("bounds the whole response even for escaped text, Unicode and multiple histories", async () => {
    for (let index = 0; index < 30; index++) {
      const watch = add(kernels[1], `value${index}`);
      for (let run = 0; run < 25; run++) {
        evaluate(watch, kernels[1], {
          output_type: "stream",
          name: "stdout",
          text: "\0🦉".repeat(8000),
        });
        await settle();
      }
    }
    const list = tools.ListJupyterWatches.execute({
      kernelId: "second",
      limit: 200,
      maxChars: 8000,
    });
    expect(Buffer.byteLength(JSON.stringify(list), "utf8")).toBeLessThanOrEqual(maxBytes);
    expect(list.responseLimited).toBe(true);
    expect(list.nextOffset).toBe(list.watches.length);
    const result = tools.GetJupyterWatch.execute({
      kernelId: "second",
      watchId: list.watches[0].watchId,
      historyLimit: 25,
      maxChars: 8000,
    });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(maxBytes);
    expect(() =>
      tools.GetJupyterWatch.execute({
        kernelId: "second",
        watchId: "w",
        historyLimit: 26,
      }),
    ).toThrowError(/historyLimit/);
  });
  it("reports missing output providers, removed watches and disconnected kernels", async () => {
    const watch = add();
    session.stores.get(kernels[1]).removeWatchByRef(watch);
    await settle();
    expect(
      tools.GetJupyterWatch.execute({
        kernelId: "second",
        watchId: watch.id,
      }).status,
    ).toBe("not-found");
    session.setOutputService(null);
    await settle();
    expect(
      tools.ListJupyterWatches.execute({
        kernelId: "second",
      }).status,
    ).toBe("available");
    session.setOutputService(outputService());
    await settle();
    expect(
      tools.ListJupyterWatches.execute({
        kernelId: "second",
      }).status,
    ).toBe("available");
    session.setProvider(null);
    await settle();
    expect(
      tools.ListJupyterWatches.execute({
        kernelId: "second",
      }).status,
    ).toBe("provider-unavailable");
  });
});
describe("watch MCP service registration", () => {
  let pkg;
  let consumer;
  let kernelService;
  let outputs;
  const registered = new Map();
  afterEach(async () => {
    if (pkg && lumine.packages.isPackageActive(pkg.name))
      await lumine.packages.deactivatePackage(pkg.name);
    consumer?.dispose();
    kernelService?.dispose();
    outputs?.dispose();
    if (pkg && lumine.packages.isPackageLoaded(pkg.name))
      await lumine.packages.unloadPackage(pkg.name);
    pkg = consumer = kernelService = outputs = null;
    registered.clear();
  });
  it("unregisters and republishes tools while keeping inactive panels passive", async () => {
    consumer = lumine.packages.serviceHub.consume("mcp.tools", "^1.0.0", (tools) => {
      const own = tools.filter((tool) =>
        ["ListJupyterWatches", "GetJupyterWatch"].includes(tool.name),
      );
      for (const tool of own) registered.set(tool.name, tool);
      return new Disposable(() => {
        for (const tool of own) registered.delete(tool.name);
      });
    });
    const source = kernel("service-kernel");
    kernelService = lumine.packages.serviceHub.provide(
      "jupyter.kernel",
      "1.0.0",
      provider([source]),
    );
    outputs = lumine.packages.serviceHub.provide("jupyter.output", "1.0.0", outputService());
    pkg = lumine.packages.loadPackage(path.resolve(__dirname, ".."));
    await lumine.packages.activatePackage(pkg.name);
    await Promise.resolve();
    const main = pkg.mainModule;
    const tool = registered.get("ListJupyterWatches");
    expect(tool).toBeDefined();
    expect(
      tool.execute({
        kernelId: source.id,
      }).status,
    ).toBe("cache-unavailable");
    expect(main.getSession().stores.size).toBe(0);
    expect(source.request).not.toHaveBeenCalled();
    expect(source.onDidBecomeIdle).not.toHaveBeenCalled();
    kernelService.dispose();
    await settle();
    expect(
      tool.execute({
        kernelId: source.id,
      }).status,
    ).toBe("provider-unavailable");
    await lumine.packages.deactivatePackage(pkg.name);
    expect(registered.size).toBe(0);
    expect(
      tool.execute({
        kernelId: source.id,
      }).status,
    ).toBe("provider-unavailable");
    await lumine.packages.activatePackage(pkg.name);
    expect(registered.size).toBe(2);
  });
});
