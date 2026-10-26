const { TextBuffer } = require("lumine");
const etch = require("@lumine-code/etch");
function hugeSource() {
  let source = TextBuffer.createTextSnapshot("x".repeat(65536));
  while (source.length < 1024 * 1024 * 1024)
    source = source.replace(source.length, source.length, source);
  return source;
}
const Watch = require("../lib/watch");
const { WatchStore } = require("../lib/watch-store");
const WatchesStore = require("../lib/watches-store");
const { recordRequest } = require("./request-fixture");
function kernel() {
  return {
    generation: 0,
    executed: [],
    requests: [],
    onDidChangeGeneration: () => ({ dispose() {} }),
    onDidBecomeIdle: () => ({ dispose() {} }),
    request(spec) {
      return recordRequest(this, spec);
    },
  };
}
describe("watch expression input budget", () => {
  let owner, store, view;
  beforeEach(() => {
    owner = kernel();
    store = new WatchStore(owner);
    view = new Watch({ store });
  });
  afterEach(() => {
    view?.destroy();
    store.destroy();
  });
  it("cancels pending work, retains a huge draft after remount, and blocks stale automatic runs", () => {
    view.editor.setText("old");
    view.handleRun();
    const request = owner.requests[0];
    const editor = view.editor;
    const read = spyOn(editor, "getText").and.throwError("whole input read");
    editor.setText(hugeSource());
    etch.updateSync(view);
    view.handleRun();
    view.blur();
    store.run();
    expect(request.disposed).toBeTrue();
    expect(owner.requests.length).toBe(1);
    expect(store.codeError).toContain("65,536");
    expect(read).not.toHaveBeenCalled();
    read.and.callThrough();
    view.destroy();
    view = new Watch({ store });
    expect(view.editor.getBuffer().getLength()).toBe(1024 * 1024 * 1024);
    view.editor.setText("new");
    view.handleRun();
    expect(owner.requests.length).toBe(2);
    expect(owner.requests[1].code).toBe("new");
    expect(store.codeError).toBeNull();
  });
  it("imports a complete giant selection as an invalid draft without a string read or execution", () => {
    const editor = lumine.workspace.buildTextEditor({ autoHeight: false });
    const watches = new WatchesStore(owner);
    try {
      editor.setText(hugeSource());
      editor.selectAll();
      const read = spyOn(editor, "getSelectedText").and.throwError("selection flatten");
      watches.addWatchFromEditor(editor);
      expect(read).not.toHaveBeenCalled();
      expect(watches.watches[0].codeSource.length).toBe(1024 * 1024 * 1024);
      expect(owner.requests.length).toBe(0);
      read.and.callThrough();
    } finally {
      editor.destroy();
      watches.destroy();
    }
  });
  it("accepts a complete boundary expression and exposes invalid legacy reads explicitly", () => {
    expect(store.setCode("a".repeat(65536))).toBeTrue();
    expect(store.getCode().length).toBe(65536);
    expect(store.setCode("b".repeat(65537))).toBeFalse();
    expect(() => store.getCode()).toThrowError(RangeError, /65,536/);
  });
});
