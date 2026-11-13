# Configuration

randl is configured with `randl serve` options and a few environment variables. There is no
configuration file. Settings changed in the dashboard (media limits, Assistant provider,
lineage settings) are stored in the database.

## Server options

`randl serve` (`npm start -- …` runs it):

| Option           | Default         | Purpose                                                                   |
| ---------------- | --------------- | ------------------------------------------------------------------------- |
| `--port`         | `8742`          | Listening port for the dashboard, SDK, API and file transfers             |
| `--host`         | `127.0.0.1`     | Listening address                                                         |
| `--data-dir`     | `.data`         | Database, uploaded files, artifacts, installed plugins, Assistant profile |
| `--public-url`   |                 | Public HTTPS address, required with a non-loopback host                   |
| `--entity`       | `local`         | Entity for runs that name none                                            |
| `--run-timeout`  | `600`           | Seconds without SDK contact before a running run is marked crashed        |
| `--frontend-dir` | `frontend/dist` | Directory of the built dashboard to serve                                 |
| `--pi-agent-dir` | `<data-dir>/pi` | Assistant (Pi) profile directory                                          |

## Environment variables

| Variable             | Read by        | Purpose                                                                    |
| -------------------- | -------------- | -------------------------------------------------------------------------- |
| `RANDL_API_KEY`      | server and CLI | The owner key. The server requires it for remote access; the CLI sends it. |
| `RANDL_PUBLIC_URL`   | server         | Same as `--public-url`                                                     |
| `RANDL_ENTITY`       | server         | Same as `--entity`                                                         |
| `RANDL_PI_AGENT_DIR` | server         | Same as `--pi-agent-dir`                                                   |
| `RANDL_FFMPEG`       | server         | Path to `ffmpeg` for video posters, or `off`                               |
| `RANDL_URL`          | CLI            | Server address; default `http://127.0.0.1:8742`                            |
| `WANDB_BASE_URL`     | W&B SDK        | Set to the server address so the SDK logs to randl                         |
| `WANDB_API_KEY`      | W&B SDK        | The server's API key, or forty zeros for a server without one              |

Test suites read further variables, listed in [Testing](../contributing/testing.md).

## Project settings

Stored per project and changed in the dashboard or with tools:

| Setting          | Where                               | Tools                                                                                                                                                  |
| ---------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lineage settings | Lineage page → **Lineage settings** | [`project_lineage_settings_get`](tools.md#project_lineage_settings_get), [`project_lineage_settings_update`](tools.md#project_lineage_settings_update) |
| Media limit      | Project **Settings → Media limit**  | [`project_media_limit_get`](tools.md#project_media_limit_get), [`project_media_limit_update`](tools.md#project_media_limit_update)                     |
| GPU inventory    | Plans page                          | [`gpus_save`](tools.md#gpus_save), [`gpus_list`](tools.md#gpus_list), [`gpus_delete`](tools.md#gpus_delete)                                            |

Lineage settings and their defaults:

| Field          | Default                                                                         | Meaning                                                  |
| -------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `metric`       | none                                                                            | The metric shown on lineage cards and finding charts     |
| `scale`        | none                                                                            | Display scale (512 shows a rate as successes out of 512) |
| `goal`         | `max`                                                                           | Whether higher (`max`) or lower (`min`) is better        |
| `parentKeys`   | `rl.checkpoint.initialize_from`, `rl.checkpoint.resume`                         | Config keys holding a run's parent checkpoint path       |
| `identityKeys` | `rl.checkpoint.save_dir`, `rl.checkpoint.run_name`                              | Config keys holding a run's own folder or name           |
| `ignoreKeys`   | `*save_dir`, `*run_name`, `*runs_root`, `*_path`, `*_dir`, `*.name`, `*.resume` | Config keys left out of diffs (`*` matches anything)     |
| `window`       | `5`                                                                             | How many recent values the recent mean covers            |
| `progressKey`  | `update`                                                                        | Summary key of a run's progress, for the GPU timeline    |
| `budgetKey`    | `rl.algorithm.total_updates`                                                    | Config key of the progress a run stops at                |
| `startKey`     | `rl.algorithm.start_update`                                                     | Config key of the progress a run starts from             |

## Server settings

[`settings_get`](tools.md#settings_get) and [`settings_update`](tools.md#settings_update) read
and change the server-wide media limit (**App settings → Storage**).
