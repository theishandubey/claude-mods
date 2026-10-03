# Working on claude-mods

This repo is a Claude Code plugin marketplace named `claude-mods`.
Each plugin under `plugins/<name>/` is a function-hooks mod (bands, panes) listed in `.claude-plugin/marketplace.json`.

## Rules

- A new plugin needs a directory under `plugins/<name>/` and an entry in `.claude-plugin/marketplace.json` with an explicit `source: "./plugins/<name>"`.
- The version lives in each plugin's `plugin.json`; marketplace entries carry no `version` field.
- `plugins/<name>/.claude-plugin/types/` is written by the engine and gitignored; never edit or commit it.
  It appears only after a `claude --plugin-dir plugins/<name>` load, and each plugin's `tsconfig.json` extends it; installed plugins do not get it.
- Check every change with `claude plugin validate plugins/<name>` and `cd plugins/<name> && claude plugin test .`.
- Validate the marketplace itself with `claude plugin validate .` from the repo root.
- Installing a new plugin on a machine is done by `agent-config/install.sh`, which reads the plugin names from `marketplace.json`.
  Enabling it everywhere also needs an `enabledPlugins` entry in `agent-config/claude/settings.json`.
- Installed plugins load in place from this checkout; after an edit, run `/reload-plugins` or restart Claude Code.
- For live iteration use `claude --plugin-dir plugins/<name>`.
- `.claude/agent-memory/` and `.claude/agent-memory-local/` hold agent memory and stay gitignored.
