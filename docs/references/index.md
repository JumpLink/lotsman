# Reference repositories

`refs/` holds read-only material. Never edit under `refs/`, and initialize a submodule only when
the task needs it: `git submodule update --init --depth 1 refs/<name>`. CI does not check the
submodules out. Formatter and linter skip them.

| Path | Kind | Read it for |
|---|---|---|
| `refs/acp/` | tracked files | the normative ACP schema ([SOURCE.md](../../refs/acp/SOURCE.md)) |
| `refs/openwork/` | shallow submodule, branch `dev` | [OpenWork](https://github.com/different-ai/openwork): a desktop app over opencode. Compare its capability MCP (`search_capabilities` / `execute_capability`), its composer dictation, its headless test setup and its worktree dev profiles. MIT outside `ee/`; `ee/` is source-available, read it but never copy from it. Electron and React: ideas, not widgets. Lotsman stays on Adwaita. |
