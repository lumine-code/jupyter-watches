# jupyter-watches

Watch expressions re-evaluated after every kernel execution.

A watch is an expression the kernel runs again every time it finishes running anything else, so a value you care about — a shape, a loss, a dataframe head — stays on screen and stays current while you work.

## Features

- **Re-runs on idle**: every watch re-evaluates when the kernel finishes an execution, wherever it came from.
- **Value history**: each watch keeps its last 25 runs, scrubbable with a slider.
- **Rich values**: watches render through jupyter-repl's renderers — plots, dataframes, LaTeX, images, not just text.
- **Real editors**: a watch expression is a real editor with the kernel's grammar and, with `autocomplete-plus`, its completions.
- **Watch the selection**: select an expression in any editor and turn it into a watch without retyping it.
- **Per kernel**: each kernel keeps its own watches, and the panel follows the active one.
- **Cached MCP access**: assistants can read existing watches and their retained outputs without running or resuming expressions.

## Installation

To install `jupyter-watches` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/jupyter-watches`.

It reads its kernels from [`jupyter-repl`](https://github.com/lumine-code/jupyter-repl), which needs to be installed too.

## Commands

Commands available in `lumine-workspace`:

- `jupyter-watches:toggle`: open the panel, or close it when it is open,
- `jupyter-watches:toggle-focus`: focus the panel, or return focus to the editor when it already has it,
- `jupyter-watches:add`: watch the selected expression, or add an empty watch to type into.

Commands available in `lumine-text-editor:not([mini])`:

- `jupyter-watches:remove`: remove the watch whose editor has the cursor.

## Usage

A new watch starts paused; Enter in its editor starts it. The run button re-evaluates immediately, pause stops the automatic re-runs without losing the history, and the slider walks back through past values.

## MCP tools

When `lumine-mcp` is connected, `ListJupyterWatches` lists existing watches for an explicit `kernelId`, as returned by `ListJupyterKernels`. Each watch has a stable `watchId` for its lifetime; `GetJupyterWatch` reads one by both IDs. Reads do not create watches or stores, open the panel, attach idle listeners, run an expression or resume a paused watch. Missing providers, stores and IDs return explanatory structured states.

The list accepts `offset` and `limit`; `GetJupyterWatch` accepts `historyLimit`, defaulting to five retained output entries and bounded to 25. The underlying history stores notebook output entries, so several entries can belong to one evaluation. The tool reports `historyKind: "output-entries"` and does not invent individual timestamps. Results include plain text, error summaries and available MIME names; HTML, images, widget state and other rich payloads are omitted.

`maxChars` bounds each expression and output field, defaulting to 1000; each complete JSON response is limited to 32 KiB. `nextOffset` continues a list limited by pagination or the response budget. Snapshots expose ISO start, settlement and last-output times, the expression that produced the latest output, watching/running flags and conservative staleness. Edited expressions, later known kernel executions, pending evaluations and a latest evaluation with no new output mark an existing output stale. `stale: false` means no known change since evaluation, not a live kernel read; unavailable execution metadata leaves it unknown (`null`). Provider removal clears the affected stores, and package deactivation withdraws the tools.

## Customization

Paste this into your `styles.css` to give each watch more vertical room:

```css
.jupyter-watches {
  .multiline-container {
    max-height: 700px;
  }
}
```

## Services

- `jupyter.context`: consumed to resolve the command's editor and expression.
- `jupyter.kernel`: consumed to follow the active kernel, run watch expressions, and re-run them when it falls idle.
- `jupyter.output`: consumed to render retained watch outputs; expressions and history remain available without it.
- `autocomplete.watch-editor`: consumed to offer completions in the watch editors.
- `mcp.tools`: provides `ListJupyterWatches` and `GetJupyterWatch` as bounded, read-only cache queries.

- `background-tips.provider`: provided to teach the package's headline action in an empty workspace.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
