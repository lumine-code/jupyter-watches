# jupyter-watches

Watch expressions re-evaluated after every kernel execution.

A watch is an expression the kernel runs again every time it finishes running anything else, so a value you care about — a shape, a loss, a dataframe head — stays on screen and stays current while you work.

## Features

- **Re-runs on idle**: every watch re-evaluates when the kernel finishes an execution, wherever it came from.
- **Value history**: each watch keeps its last 25 values, scrubbable with a slider.
- **Rich values**: watches render through jupyter-repl's renderers — plots, dataframes, LaTeX, images, not just text.
- **Real editors**: a watch expression is a real editor with the kernel's grammar and, with `autocomplete-plus`, its completions.
- **Watch the selection**: select an expression in any editor and turn it into a watch without retyping it.
- **Per kernel**: each kernel keeps its own watches, and the panel follows the active one.

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

- `jupyter.kernel`: consumed to follow the active kernel, run watch expressions, and re-run them when it falls idle.
- `jupyter.output`: consumed to record results and render them with jupyter-repl's renderers.
- `autocomplete.watch-editor`: consumed to offer completions in the watch editors.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
