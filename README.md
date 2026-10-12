# claude-mods

A Claude Code plugin marketplace of mods: function-hooks plugins that draw bands, panes and other UI inside Claude Code.

## Plugins

| Plugin | What it does |
|---|---|
| `meter` | Band above the prompt showing context, prompt cache, usage limits and cost; `/meter` opens a detailed metrics pane. Works in the terminal and the desktop app. |
| `agent-graph` | Pane graphing the session's running subagents: a left-to-right card graph in the desktop app, which opens it on the first subagent, and an indented tree in the terminal, opened with `/agent-graph`. |
| `statusline` | A styled row under the prompt's mode line, above the engine's hints: model (warning colour on a fallback), effort, directory, branch with a `●` when dirty and `↑N↓N` against the upstream. Terminal only; the desktop app shows the model in its own composer. |

## Install

```bash
git clone <repo-url> claude-mods
claude plugin marketplace add ./claude-mods
claude plugin install meter@claude-mods --scope user
claude plugin install agent-graph@claude-mods --scope user
claude plugin install statusline@claude-mods --scope user
```

## Layout

```
claude-mods/
├── .claude-plugin/
│   └── marketplace.json          # marketplace name, owner, plugin list
└── plugins/
    └── <name>/
        ├── .claude-plugin/
        │   └── plugin.json       # name, version, description
        ├── hooks/                # hooks.json and the function-hooks modules
        ├── types/                # this plugin's exported types ("types" in plugin.json)
        └── tsconfig.json
```

## Development

Installed plugins load in place from this checkout.
After editing, run `/reload-plugins` or restart Claude Code.
For live iteration without installing, run `claude --plugin-dir plugins/<name>`.

Check a plugin with:

```bash
claude plugin validate plugins/<name>
cd plugins/<name> && claude plugin test .
```

Check the marketplace with `claude plugin validate .` from the repo root.

## License

[MIT](LICENSE)
