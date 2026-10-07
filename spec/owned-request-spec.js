const etch = require("@lumine-code/etch");
const { WatchStore } = require("../lib/watch-store");
const WatchesSession = require("../lib/watches-session");
const WatchesPane = require("../lib/watches-pane");
const { recordRequest, generationKernel, settle } = require("./request-fixture");
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
  it("replays the same raw clear and display update events after renderer replacement", async () => {
    const session = new WatchesSession();
    session.setKernel(kernel());
    const watch = session.storeFor().createWatch();
    const events = [
      { output_type: "stream", name: "stdout", text: "before" },
      { output_type: "clear_output", wait: true },
      {
        output_type: "display_data",
        transient: { display_id: "value" },
        data: { "text/plain": "original" },
        metadata: {},
      },
      {
        output_type: "update_display_data",
        transient: { display_id: "value" },
        data: { "text/plain": "updated" },
        metadata: {},
      },
    ];
    events.forEach((event) => watch.outputStore.appendOutput(event));
    const service = () => ({
      reduceOutputEvents: jasmine
        .createSpy("replay raw events")
        .and.returnValue([{ output_type: "display_data", data: { "text/plain": "updated" } }]),
      normalizeOutput: (output) => output,
      renderDisplay: (output) => etch.dom("pre", {}, output.data["text/plain"]),
    });
    const first = service();
    session.setOutputService(first);
    const pane = new WatchesPane(session);
    etch.updateSync(pane.component);
    expect(first.reduceOutputEvents).toHaveBeenCalledWith(events);
    expect(pane.element.textContent).toContain("updated");
    const editor = [...session.storeFor().editors.keys()][0];
    session.setOutputService(null);
    etch.updateSync(pane.component);
    const next = service();
    session.setOutputService(next);
    etch.updateSync(pane.component);
    await settle();
    expect(next.reduceOutputEvents).toHaveBeenCalledWith(events);
    expect(watch.outputStore.outputs).toEqual(events);
    expect([...session.storeFor().editors.keys()][0]).toBe(editor);
    expect(editor.isDestroyed()).toBe(false);
    pane.destroy();
    session.destroy();
  });
});
