describe("watch command availability", () => {
  it("limits removal to owned watch input editors", () => {
    const main = require("../lib/main");
    main.initialize();
    main.activate();
    const editor = lumine.workspace.buildTextEditor();
    const target = editor.getElement();
    try {
      expect(lumine.commands.canDispatch(target, "jupyter-watches:remove")).toBe(false);
      target.classList.add("watch-input");
      expect(lumine.commands.canDispatch(target, "jupyter-watches:remove")).toBe(true);
    } finally {
      editor.destroy();
      main.deactivate();
    }
  });
});
