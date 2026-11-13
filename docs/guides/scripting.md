# Scripting and agents

Everything the dashboard changes goes through a management **tool**, and every tool is an HTTP
endpoint. The `randl` CLI wraps the common ones in commands. Scripts, CI jobs and coding agents
such as Claude Code or Codex use either.

## The CLI

```sh
alias randl="node $PWD/backend/dist/cli.js"   # from the repository; or: npm run randl -- …
export RANDL_URL=http://127.0.0.1:8742        # the default
export RANDL_API_KEY=…                        # only if the server has a key
randl --help
```

- Every command prints JSON on standard output, so it combines with `jq`.
- Errors go to standard error with a non-zero exit status. Commands never prompt.
- `--url` overrides `RANDL_URL` for one command.

A view built from a script:

```sh
VIEW=$(randl views create --project team/navigation --name "Best learning rate" | jq -r .id)
randl panels add --view "$VIEW" --metric eval/return
randl runs --project team/navigation \
  | jq '[.[] | select(.state == "finished") | .id]' \
  | randl select --view "$VIEW" --solo-file -
```

The [CLI reference](../reference/cli.md) lists every command.

## Any tool, from the CLI

`randl tools` prints the catalog with a JSON Schema for each tool's arguments, and `randl tool`
calls any of them with every argument it takes:

```sh
randl tools | jq -r '.tools[].name'
randl tool panel_add --json '{"view": "VIEW_ID", "plugin": "line", "metric": "losses/value", "settings": {"groupBy": "config.lr"}}'
```

## Over HTTP

```http
POST /api/tools/runs_list
Content-Type: application/json
Authorization: Bearer $RANDL_API_KEY

{ "project": "team/navigation" }
```

```sh
curl -s "$RANDL_URL/api/tools/runs_list" -H 'content-type: application/json' \
  -H "authorization: Bearer $RANDL_API_KEY" -d '{"project": "team/navigation"}'
```

Errors return a status of 400 or more with `{"error", "code", "params"}`; branch on `code`, not
on the message. A 503 with `Retry-After` means the database was busy: retry. The
[tool reference](../reference/tools.md) documents every tool with an example request and
response.

## Writing safe scripts

- **Name yourself.** Pass `by` (`--by`) on every change; the audit log records it with the
  arguments.
- **Use your own IDs.** Ledger records, plans, ideas and journal entries take caller-chosen IDs,
  so a script that runs twice changes nothing the second time.
- **Dry-run first.** Ledger, planning and history tools take `dryRun` (`--dry-run`) and report
  what they would do.
- **Read before you save a view.** `view_save` takes the `version` you read and refuses a newer
  one with `VIEW_CONFLICT`; read again and reapply.
- **Edit runs after they end.** A running run's SDK re-sends its config and would replace keys you
  set with `run_metadata_update`.

## Coding agents

The CLI is built to be driven by agents: it never prompts, prints JSON and reports errors with a
non-zero status. The repository ships skills for Claude Code in `.claude/skills/`:

| Skill                 | For                                                                    |
| --------------------- | ---------------------------------------------------------------------- |
| `randl-tracking`      | Logging runs, journals, verdicts, findings, the stopped state, recipes |
| `randl-planning`      | GPUs, plans, the queue, ideas, resume plans, host agents               |
| `randl-workspace`     | Views, panels, selections, comparisons, lineage navigation             |
| `randl-custom-panels` | Writing, testing and installing a panel plugin                         |
| `randl-deploy`        | Building, testing, backing up, restarting and rolling back             |

Other agents can read `randl --help`, `randl tools` and these docs.
