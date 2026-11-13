<p align="center">
  <img src="frontend/public/favicon.svg" width="64" height="64" alt="">
</p>

<h1 align="center">randl</h1>

<p align="center">
  <b>Self-hosted experiment tracking for the W&amp;B Python SDK.</b><br>
  Keep your <code>wandb.init()</code> and <code>wandb.log()</code> code; send the runs to your own server.
</p>

<p align="center">
  <b>English</b> ·
  <a href="README.zh-Hans.md">简体中文</a> ·
  <a href="README.zh-Hant.md">繁體中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.es.md">Español</a>
</p>

![A randl workspace comparing twelve runs of a learning-rate sweep](.github/assets/readme/hero.webp)

randl ("rewards and losses") is an experiment tracker you run yourself. The stock `wandb`
package logs to it when you set two environment variables. One Node.js process serves a fast
dashboard, the `randl` command line, an HTTP tools API and an optional AI Assistant, and keeps
everything in one SQLite database and a folder of files.

- **Drop-in for the W&B SDK:** metrics, config, media, files, artifacts, resume, offline sync
  and stop requests, tested with `wandb` 0.30.0.
- **A complete dashboard:** saved views, grouping, smoothing, computed metrics, media panels,
  a runs table and custom panel plugins, in seven languages.
- **Lineage and a research ledger:** runs linked to the runs they started from; findings,
  journals, verdicts and the best recipe kept beside them.
- **A GPU queue:** plans with GPU requests that host agents claim, on a timeline of your GPUs.
- **Scriptable:** every change is a tool that the dashboard, the CLI, scripts and coding agents
  share.

## Quick start

Requires Node.js 22.19 or newer.

```sh
npm ci && npm run build && npm start
```

Then, in the shell that runs your training code:

```sh
export WANDB_BASE_URL=http://127.0.0.1:8742
export WANDB_API_KEY=0000000000000000000000000000000000000000
python train.py
```

Open <http://127.0.0.1:8742>. [Getting started](docs/getting-started.md) walks through it.

## Documentation

- [Overview](docs/overview.md) and [getting started](docs/getting-started.md)
- Guides: [workspace and panels](docs/guides/workspace.md), [lineage](docs/guides/lineage.md),
  [experiment ledger](docs/guides/ledger.md), [planning and the GPU queue](docs/guides/planning.md),
  [scripting and agents](docs/guides/scripting.md), [the Assistant](docs/guides/assistant.md),
  [custom panels](docs/guides/custom-panels.md), [deployment](docs/guides/deployment.md),
  [performance](docs/guides/performance.md)
- Reference: [tools](docs/reference/tools.md), [CLI](docs/reference/cli.md),
  [lineage block](docs/reference/lineage-block.md), [configuration](docs/reference/configuration.md),
  [panel plugin API](docs/reference/panel-api.md),
  [W&B compatibility](docs/reference/wandb-compatibility.md)
- [Contributing](docs/contributing/README.md)

Coding agents such as Claude Code can use the skills in [.claude/skills](.claude/skills/).

## Status

randl is young and unreleased; expect breaking changes. It is an independent implementation,
not affiliated with Weights & Biases.

## License

randl is released under the [MIT License](LICENSE).
