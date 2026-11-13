---
name: randl-workspace
description: Build and change randl dashboard workspaces through the tools API and CLI - create views, add and configure panels (line, scatter, media, computed metrics, grouping, smoothing), show and solo runs, compare runs, and navigate run lineage with links to the Lineage page. Use when asked to set up charts, compare runs, make a view for an experiment, or point someone at runs in randl.
---

# Workspaces, panels and comparisons in randl

A **view** is a saved workspace for one project: sections of panels, visible and soloed runs,
colours and plot settings. Tools change views the same way the dashboard does. Details:
[workspace guide](../../../docs/guides/workspace.md),
[view, panel and plot-settings shapes](../../../docs/reference/tools.md#shared-shapes).

Setup: `RANDL_URL`, `RANDL_API_KEY` if set, `alias randl="node /path/to/randl/backend/dist/cli.js"`.

## 1. Find what exists

```sh
randl tool workspace_snapshot --json '{}'                 # projects, views, plugins
randl views list
randl runs --project team/navigation | jq '.[] | {id, display_name, state, group_name}'
randl tool metrics_list --json '{"runs": ["team/navigation/wide02"]}'
```

Use metric names exactly as `metrics_list` returns them.

## 2. Make a view and add panels

```sh
VIEW=$(randl views create --project team/navigation --name "Width study" | jq -r .id)
randl panels add --view "$VIEW" --metric eval/return
randl panels add --view "$VIEW" --plugin scatter --metrics eval/return,train/loss
randl panels add --view "$VIEW" --metric rate --expressions '[{"name": "rate", "expression": "${rollout/hits} / ${rollout/episodes}"}]'
```

Settings the short commands lack go through `panel_add` / `panel_update`:

```http
POST /api/tools/panel_add

{"view": "VIEW_ID", "plugin": "line", "metric": "eval/return", "title": "Return by update", "settings": {"xAxis": "update", "smoothingMethod": "ema", "smoothingValue": 0.6, "groupBy": "config.lr", "aggregation": "mean", "spread": "minmax"}}
```

- Plugins: `line`, `area`, `stacked-area`, `percent-area`, `bar`, `scatter`,
  `scatter-history`, `parallel`, `histogram`, `table`, `image`, `audio`, `video`, plus installed
  ones (`randl plugins list`). Check the exact IDs with `plugins_list`.
- `groupBy`: `none`, `all`, or a run field such as `config.lr`, `tags`, `group_name`.
- Plugin options: `settings.options[pluginId] = {...}`; invalid ones fail with
  `PLUGIN_OPTION_INVALID`.

## 3. Choose runs

```sh
randl select --view "$VIEW" --solo team/navigation/wide02,team/navigation/lr03
randl runs --project team/navigation | jq '[.[] | select(.state == "finished") | .id]' | randl select --view "$VIEW" --visible-file -
randl select --view "$VIEW" --solo-file - <<< '[]'          # clear solos
```

Solos override visibility without changing it. At most 100,000 IDs per selection.

## 4. Edit a whole view safely

Read, change, save with the version you read:

```sh
randl views get --id "$VIEW" > view.json
# edit .body (pinned, runColors, plotSettings, sections, filters…)
randl tool view_save --json "$(jq '{id, name, project, version, body}' view.json)"
```

`VIEW_CONFLICT`: someone saved after your read. Read again, reapply, save.

## 5. Compare and navigate lineage

```sh
randl tool runs_compare --json '{"baseline": "team/navigation/wide02", "runs": ["team/navigation/lr03"], "metric": "eval/return", "x": "update"}'
randl tool runs_config_diff --json '{"from": "team/navigation/base01", "to": "team/navigation/wide02"}'
randl tool project_lineage --json '{"id": "team/navigation"}' | jq '.edges[] | {source, target, relation}'
```

Link people to pages:

- Run page: `$RANDL_URL/team/navigation/runs/wide02` (the SDK run ID)
- Lineage, opened on a run: `$RANDL_URL/team/navigation/lineage?run=team/navigation/wide02`
  (the full run ID)
- Lineage with runs selected to compare: `$RANDL_URL/team/navigation/lineage?select=wide02,lr03`
  (SDK run IDs, comma-separated)

Check a link in a browser before handing it over if the route matters.

## Checklist

- [ ] Metric names come from `metrics_list`; plugin IDs from `plugins_list`.
- [ ] The view's project matches the runs' project.
- [ ] Read the result back with `randl views get --id VIEW`.
