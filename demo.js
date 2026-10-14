// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: ["language-python", "jupyter-cells", "jupyter-repl"],
  viewport: { width: 1200, height: 760 },
  async before() {},
  async prepare(context) {
    const { lumine, state, fixture, open, profile } = context;
    state.jupyterData = require("path").join(profile, "jupyter");
    const kernel = require("path").join(state.jupyterData, "kernels", "lumine-demo");
    require("fs").mkdirSync(kernel, { recursive: true });
    require("fs").writeFileSync(
      require("path").join(kernel, "kernel.json"),
      JSON.stringify({
        argv: [
          process.env.LUMINE_DEMO_PYTHON || "python",
          "-m",
          "ipykernel_launcher",
          "-f",
          "{connection_file}",
        ],
        display_name: "Python 3",
        language: "python",
      }),
    );
    state.editor = await open("jupyter/signal.py");
    await lumine.project.setPaths([fixture("jupyter")]);
    process.env.JUPYTER_PATH = state.jupyterData;
    lumine.grammars.assignLanguageMode(state.editor.getBuffer(), "source.python");
    await state.editor.getBuffer().getLanguageMode().ready;
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Use jupyter-watches with the running Python kernel.",
      timeout: 60000,
      async run(context) {
        const { lumine, state, waitFor } = context;
        {
          state.editor.selectAll();
          lumine.commands.dispatch(lumine.views.getView(state.editor), "jupyter-repl:run");
          await waitFor(
            () => document.body.innerText.includes("Mean amplitude: 0.42"),
            "step 1",
            60000,
          );
        }
        {
          state.editor.setSelectedBufferRange([
            [9, 0],
            [9, 7],
          ]);
          lumine.views.getView(state.editor).focus();
          lumine.commands.dispatch(lumine.views.getView(state.editor), "jupyter-watches:add");
          await new Promise((r) => setTimeout(r, 400));
          await lumine.workspace.open("lumine://jupyter-watches");
          lumine.workspace.getRightDock().show();
          state.editor.setCursorBufferPosition([9, 0]);
          const item = lumine.workspace
            .getPaneItems()
            .find((i) => i.getURI?.() === "lumine://jupyter-watches");
          const store = item.session.storeFor(item.session.kernel);
          for (const watch of store.watches.slice(0, -1)) store.removeWatchByRef(watch);
        }
      },
      ready() {
        return Boolean(document.querySelector(".jupyter-watches")?.innerText.includes("samples"));
      },
    },
  ],
  async cleanup() {},
};
