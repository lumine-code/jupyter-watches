const etch = require("@lumine-code/etch");
const { WatchStore } = require("../lib/watch-store");
const WatchesSession = require("../lib/watches-session");
const WatchesPane = require("../lib/watches-pane");
const {
  recordRequest,
  generationKernel,
  settle,
  createOutputAccumulator,
} = require("./request-fixture");
function kernel() {
  return generationKernel({
    language: "python",
    requests: [],
    request(specification) {
      return recordRequest(this, specification);
    },
    onDidBecomeIdle: () => ({ dispose() {} }),
  });
}
describe("owned watch models", () => {
  it("keeps its expression and history while cancelling an older session generation", async () => {
    const source = kernel();
    const watch = new WatchStore(source);
    watch.setCode("value");
    watch.toggleWatching();
    source.requests[0].receive({ output_type: "stream", name: "stdout", text: "retained" });
    source.advanceGeneration();
    await settle();
    expect(source.requests[0].disposed).toBe(true);
    expect(watch.getCode()).toBe("value");
    expect(watch.outputStore.outputs[0].text).toBe("retained");
    expect(watch.isWatching).toBe(true);
    expect(watch._running).toBe(false);
    watch.run();
    expect(source.requests[1].generation).toBe(1);
    watch.destroy();
  });
  it("recreates view editors without recreating the watch definition or its outputs", async () => {
    const session = new WatchesSession();
    session.setKernel(kernel());
    const watch = session.storeFor().createWatch();
    watch.setCode("value");
    watch.outputStore.appendOutput({ output_type: "stream", name: "stdout", text: "retained" });
    const original = new WatchesPane(session);
    etch.updateSync(original.component);
    const firstEditor = [...session.storeFor().editors.keys()][0];
    expect(firstEditor.getText()).toBe("value");
    original.destroy();
    await settle();
    expect(firstEditor.isDestroyed()).toBe(true);
    expect(watch.destroyed).not.toBe(true);
    const replacement = new WatchesPane(session);
    etch.updateSync(replacement.component);
    const secondEditor = [...session.storeFor().editors.keys()][0];
    expect(secondEditor).not.toBe(firstEditor);
    expect(secondEditor.getText()).toBe("value");
    expect(replacement.element.textContent).toContain("retained");
    replacement.destroy();
    session.destroy();
  });
  it("incrementally bounds thousands of chunks and preserves cursor, clear and display state across renderer replacement", async () => {
    const source = kernel();
    const session = new WatchesSession();
    session.setKernel(source);
    const factory = () =>
      jasmine.createSpy("pure accumulator factory").and.callFake(createOutputAccumulator);
    const first = { createOutputAccumulator: factory() };
    session.setOutputService(first);
    const watch = session.storeFor().createWatch();
    watch.setCode("value");
    watch.toggleWatching();
    const request = source.requests[0];
    expect(request.specification.collectOutputs).toBe(false);
    for (let index = 0; index < 5000; index++)
      request.receive({ output_type: "stream", name: "stdout", text: "x" });
    expect(watch.outputStore.outputs.length).toBe(1);
    expect(watch.outputStore.outputs[0].text.length).toBe(5000);
    request.receive({ output_type: "stream", name: "stdout", text: "\r" });
    session.setOutputService(null);
    const replacement = { createOutputAccumulator: factory() };
    session.setOutputService(replacement);
    request.receive({ output_type: "stream", name: "stdout", text: "Y" });
    expect(watch.outputStore.outputs[0].text).toBe("Y" + "x".repeat(4999));
    expect(first.createOutputAccumulator).toHaveBeenCalledTimes(1);
    expect(replacement.createOutputAccumulator).not.toHaveBeenCalled();
    request.receive({
      output_type: "display_data",
      transient: { display_id: "value" },
      data: { "text/plain": "original" },
      metadata: {},
    });
    request.receive({ output_type: "clear_output", wait: true });
    session.setOutputService(null);
    session.setOutputService({ createOutputAccumulator: factory() });
    request.receive({
      output_type: "update_display_data",
      transient: { display_id: "value" },
      data: { "text/plain": "updated" },
      metadata: {},
    });
    expect(watch.outputStore.outputs.length).toBe(2);
    expect(watch.outputStore.outputs[1].data["text/plain"]).toBe("updated");
    request.receive({ output_type: "stream", name: "stdout", text: "after" });
    expect(watch.outputStore.outputs.length).toBe(1);
    expect(watch.outputStore.outputs[0].text).toBe("after");
    request.finish();
    await settle();
    session.setOutputService(null);
    watch.run();
    source.requests[1].receive({ output_type: "stream", name: "stdout", text: "new run" });
    expect(watch.outputStore.history[0][0].text).toBe("after");
    expect(watch.outputStore.history[1][0].text).toBe("new run");
    session.destroy();
  });

  it("converts pre-factory records once when the first renderer arrives", () => {
    const session = new WatchesSession();
    session.setKernel(kernel());
    const watch = session.storeFor().createWatch();
    watch.outputStore.appendOutput({ output_type: "stream", name: "stdout", text: "ab" });
    watch.outputStore.appendOutput({ output_type: "stream", name: "stdout", text: "cd\r" });
    session.setOutputService({ createOutputAccumulator });
    session.setOutputService(null);
    watch.outputStore.appendOutput({ output_type: "stream", name: "stdout", text: "X" });
    expect(watch.outputStore.outputs.length).toBe(1);
    expect(watch.outputStore.outputs[0].text).toBe("Xbcd");
    session.destroy();
  });

  it("retains partial output and exposes terminal failure without collecting a second result buffer", async () => {
    const source = kernel();
    const watch = new WatchStore(source, createOutputAccumulator);
    watch.setCode("value");
    watch.toggleWatching();
    const request = source.requests[0];
    request.receive({ output_type: "stream", name: "stdout", text: "partial" });
    request.finish({ status: "timeout" });
    await settle();
    expect(watch.outputStore.outputs[0].text).toBe("partial");
    expect(watch.outputStore.outputs[1].output_type).toBe("error");
    expect(watch.outputStore.outputs[1].evalue).toContain("timeout");
    expect(watch._running).toBe(false);
    expect((await request.done).outputs).toEqual([]);
    watch.destroy();
  });
});
