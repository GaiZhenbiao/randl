# randl documentation

randl ("rewards and losses") is a self-hosted experiment tracker that the W&B Python SDK logs
to. These pages cover using it, running it, scripting it and working on it.

## Start here

- [Overview](overview.md): what randl is and the objects it works with.
- [Getting started](getting-started.md): install randl, log a first run, open it.

## Guides

| Guide                                            | Covers                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| [Workspace and panels](guides/workspace.md)      | Views, panels, run selection, grouping, smoothing, media, the runs table |
| [Lineage](guides/lineage.md)                     | How runs link to the runs they started from, and the Lineage page        |
| [Experiment ledger](guides/ledger.md)            | Findings, journals, verdicts, the stopped state, the recipe, evidence    |
| [Planning and the GPU queue](guides/planning.md) | GPU inventory, plans, the queue, projection, ideas, host agents          |
| [Scripting and agents](guides/scripting.md)      | The `randl` CLI, the tools API, and coding agents                        |
| [The Assistant](guides/assistant.md)             | The built-in Assistant, providers and conversations                      |
| [Custom panels](guides/custom-panels.md)         | Writing, installing and testing a panel plugin                           |
| [Deployment and operation](guides/deployment.md) | Hosting, authentication, backups, upgrades and rollback                  |
| [Performance](guides/performance.md)             | What keeps randl fast and what you can tune                              |

## Reference

| Reference                                             | Contents                                                  |
| ----------------------------------------------------- | --------------------------------------------------------- |
| [Tools](reference/tools.md)                           | Every HTTP tool with its arguments, an example and errors |
| [CLI](reference/cli.md)                               | Every `randl` command                                     |
| [The lineage block](reference/lineage-block.md)       | The `lineage` config block runs log                       |
| [Configuration](reference/configuration.md)           | Server options and environment variables                  |
| [Panel plugin API](reference/panel-api.md)            | Manifest, renderer lifecycle, data shapes and options     |
| [W&B compatibility](reference/wandb-compatibility.md) | What the SDK can and cannot do against randl              |

The tool and CLI references are generated from the code by `npm run docs`, and
`npm test` fails when they fall behind.

## Contributing

- [Contributing](contributing/README.md): development setup, conventions and where to start.
- [Architecture](contributing/architecture.md) and [storage](contributing/storage.md).
- [Testing](contributing/testing.md): unit, browser, SDK and documentation checks.
- [Design system](contributing/design-system.md): the header rail, run names, colour, writing
  and localization rules the interface follows.

## Agent skills

`.claude/skills/` holds skills for coding agents such as Claude Code: tracking runs and the
ledger, planning and host agents, the workspace, custom panels and deployment. Each skill
is a short procedure that links back to these pages.

## History

[history/](history/README.md) keeps records of past decisions and measurements. They
describe how randl got here, not how it works now.
