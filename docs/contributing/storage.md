# Storage

randl keeps everything except uploaded files in one SQLite database, `randl.sqlite3`, in the
data directory. Run history is stored twice, both losslessly: the exact text the SDK sent,
and a numeric index that charts read. Both are packed into zlib-compressed blocks with small
uncompressed tails. Nothing is discarded and numeric precision is never reduced; the only
retention rule is the [media limit](#media-limit) on logged media files.

For how the database worker and the HTTP process fit together, see
[architecture.md](architecture.md).

## Data directory

| Path                                 | Contents                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `randl.sqlite3` (and `-wal`, `-shm`) | The database                                                                     |
| `files/<SHA-256 of run ID>/`         | Files a run uploaded: media, `wandb-metadata.json`, requirements and other files |
| `artifacts/<artifact ID>/`           | Artifact manifests and files                                                     |
| `plugins/<plugin ID>/`               | Installed panel plugins                                                          |
| `pi/`                                | The Assistant's Pi profile, unless a shared one is configured                    |
| `cache/posters/`                     | First frames of videos as JPEG images                                            |

`cache/posters/` keeps at most 4,000 images, removing the oldest first. Deleting it is safe;
the server makes posters again when needed.

## Format and schema

`PRAGMA user_version=2` marks storage format 2, the only format the server reads. Opening a
data directory (`Store` in `backend/src/database.ts`) works like this:

1. If the database has tables and `user_version` is not 2, the server refuses to start with
   "This data directory uses an unsupported randl storage format". There is no reader for
   older formats and no conversion at startup.
2. A new, empty database gets 4096-byte pages and `auto_vacuum=INCREMENTAL`. These can only
   be set before the first table exists.
3. Every database is opened in WAL mode with `journal_size_limit` at 64 MiB.
4. Tables are created with `CREATE TABLE IF NOT EXISTS`. For a new database, creating every
   table and setting `user_version=2` happen in one transaction, and the server then checks
   the page size and auto-vacuum mode; a failure rolls everything back.

### Column upgrades

There are no numbered migrations. Instead, `ensureTables` in `backend/src/schema.ts` lets a
table gain columns:

- It creates each declared table if it is missing.
- It compares the stored table with a temporary copy of the declaration, and adds each
  missing column with its type and default. A new column keeps `NOT NULL` only when it has a
  default, because existing rows need a value.
- A missing primary key column cannot be added, and stops startup with an error.
- It then runs the rest of the SQL (indexes may name the new columns).

`ensureTables` covers the run, project, view, plugin, settings, session, audit and alert
tables, metric renames, artifacts, conversations and the ledger tables. The history tables
in `history-store.ts` are created with plain `CREATE TABLE IF NOT EXISTS` and gain no
columns; changing their layout needs a new storage format.

To add a column, add it to the table's declaration with a default; existing databases gain
it at the next start. `tests/schema-upgrade.test.mjs` covers this.

One-off data repairs are scripts rather than startup steps: `scripts/rebuild-runtimes.mjs --data-dir DIR`
recomputes run runtimes for data written before active-time runtimes. Stop
the server before running it.

## History tables

Run IDs, metric names and stream file names are mapped to integers in `run_keys`,
`metric_names` and `stream_files`. Every run has an explicit, stable key in `run_keys`;
SQLite's implicit row IDs are not run identities.

| Table           | Contents                                                            |
| --------------- | ------------------------------------------------------------------- |
| `point_tail`    | Recent numeric points: run, metric, step, value                     |
| `point_blocks`  | Sealed numeric points, with range, count and value statistics       |
| `stream_tail`   | Recent stream lines: run, file, offset, exact text                  |
| `stream_blocks` | Sealed stream lines, with offset range, size and history step range |
| `run_metrics`   | Which metrics each run has                                          |
| `media`         | Logged media values by run, metric and step (not compressed)        |

Run metadata (config, summary, tags, state, revision) lives in the `runs` table, apart from
history.

### Invariants

For each series or stream:

- Blocks have disjoint, increasing ranges.
- Every tail coordinate is greater than the last sealed coordinate.
- A coordinate (step or offset) occurs once across blocks and tail.

Late writes keep these true. A late point replaces the point at an equal step or is inserted
into the block that precedes it; a late line does the same by offset. Several late writes to
one block are combined before the block is rewritten. An identical history retry is ignored;
a conflicting one fails the whole request.

## Point blocks

Encoding is in `backend/src/history-codec.ts`.

- A block normally holds 1,024 points. A rewritten block over 2,048 points is split.
- Steps that are all nonnegative safe integers are stored as unsigned LEB128 deltas (codec
  1); other steps as little-endian Float64 (codec 0).
- Values are always Float64. Negative zero becomes zero, as in SQLite `REAL` columns.
- Steps and values are compressed separately with zlib level 6.
- Each block row stores its first and last step, count, minimum, maximum and last value. A
  unique index over these columns serves ranges, counts, extrema and latest values without
  decompressing anything. Range statistics decode only the steps of the blocks at the edges.

## Stream blocks

- A block normally holds at most 256 lines and 4 MiB of UTF-8. A single line larger than
  that gets a block of its own.
- Each line is framed as an unsigned varint offset delta, an unsigned varint byte length,
  then the exact bytes. Gaps between offsets are kept.
- For history, the block row records the highest numeric `_step` in the block and the
  offset where it first occurs.
- A rewritten block over 512 lines or 8 MiB is split.
- `wandb-summary.json` is never sealed: the SDK keeps replacing its single record at offset
  zero, so it stays in the tail.

## Byte accounting

`runs.stream_bytes` is the logical, uncompressed UTF-8 size of a run's stream lines.
Triggers on `stream_tail` and `stream_blocks` maintain it, so moving lines from tail to block
changes nothing. `runs.file_bytes` is the size of the run's uploaded files, updated by the
upload route and by the media limit. Project lists and details sum these with artifact file
sizes, so they never walk the data directory. Project storage figures exclude SQLite pages,
indexes and derived points.

Project deletion removes the project's rows in one database transaction, then deletes its
run and artifact folders.

## Media limit

While the media limit is on, a run keeps at most its size in mebibytes of logged media
files: every run file that the run's media values name (images, videos, audio, tables, HTML,
3D objects, and the masks and boxes drawn on images). Code: `backend/src/media-cap.ts`.

### Settings

- The server's limit, `mediaLimit: {enabled, megabytes}`, is on at 500 by default. It is set
  on the **App settings** page under **Storage**, or with the `settings_get` and
  `settings_update` tools.
- A project uses the server's limit unless its settings say otherwise: **Settings → Media
  limit** in the project, or the `project_media_limit_get` and `project_media_limit_update`
  tools. These hold `inherit` (true by default), the project's own `enabled` and
  `megabytes`, and its thinning `axis` (`_step` by default).
- The Assistant cannot change either.

### When runs are measured

The limit applies to every run, finished runs included. The server measures all runs with
media when it starts and whenever the server's or a project's limit changes, four runs per
pass, so turning the limit on or lowering it thins runs already over it. After that, a run is
measured when it uploads a media file, about two seconds after the upload.

### What is removed

A run over the limit loses entries until its files fit in 90% of the limit, so the next
upload does not thin it again.

- Each removal comes from the metric key that holds the most bytes.
- Within that key, it removes the entry whose two neighbors are closest on the project's
  thinning axis, the earliest among equals. The axis is the step by default, or a runtime,
  wall time or metric the project's settings name. A media entry takes the axis metric's
  value at its step or the last value before it; a run with an entry that has no value on
  the axis is spaced by step instead. The axes of views play no part.
- Evenly logged media therefore lose every other entry, then every other of the rest. The run
  keeps media over its whole length at a wider spacing, and newer media are thinned to match
  older ones.
- Every key keeps its newest entry, and its first entry while the key has entries in between.
- Entries with a file still uploading are never removed. A file that several entries name is
  deleted with the last of them.

Removal deletes the media rows, then the files, subtracts the bytes from the run's
`file_bytes`, and advances the run's revision. History rows, scalar points and values
without files (such as histograms) are untouched. Removed files are gone from the run's Files
tab too.

`media_limit_apply` with `dryRun: true` reports the runs, entries, files and bytes the limit
would remove, without removing them. With `dryRun: false` it applies the limit to every run
and waits for the result.

## Writes

The database worker owns all reads and writes of rows. A file-stream request is one SQLite
transaction, including late rewrites and any seals done inline. If it rolls back, the history
store clears its caches (dictionaries, block boundaries, counts and the one decoded stream
block) before the next request. These caches are bounded by the stored dictionaries and
series; the decoded block is usually at most 4 MiB.

During ingest the store seals full point tails inline, at most 64 blocks within a 24 ms
budget per request. Stream lines are not compressed inline: encoding a 256-line block can
take longer than the whole inline budget, so it waits for maintenance.

Sealing changes neither a run's revision nor its update time, and does not invalidate chart
revisions.

## Maintenance

Every ten seconds, after the stale-run check, the server asks the database worker to
maintain storage if no other calls are waiting (`storageMaintain` in `server.ts`).

- Each call admits at most one point block and one stream block, with a 50 ms budget.
- The server yields to the request queue after each call, and keeps calling only while the
  queue is empty and within 200 ms per tick. A single compression or vacuum step may finish
  after its budget.
- Running runs seal only full blocks. Finished runs and imported snapshots also seal partial
  tails. A resumed run tops up its last partial block before starting another.
- When free pages exceed 64 MiB, maintenance runs `PRAGMA incremental_vacuum(1024)`, which
  frees up to 4 MiB per pass at 4096-byte pages. A large deletion can take many ticks to
  return its pages. The checkpoint worker then applies the smaller file size.

No full `VACUUM` is needed.

## WAL and checkpoints

The application connection has automatic checkpoints off (`wal_autocheckpoint=0`, set by
`db-worker.ts`). The checkpoint worker (`backend/src/db-checkpoint.ts`) has its own write
connection and two read-only connections:

- Every 250 ms, if the WAL has frames not yet checkpointed, it opens a read snapshot on one
  reader before releasing the other's (so there is never a gap that would let the WAL
  rewind), syncs the WAL file, and runs a passive checkpoint. Holding a snapshot spares the
  application writer from syncing a new WAL header after every poll.
- When the WAL holds 32 MiB of frames, or has not changed for one second, it asks the
  database worker for a catch-up window. The worker pauses admitting requests for at most
  20 ms while the checkpoint worker releases its snapshots and checkpoints the remainder, so
  the next WAL can reuse the file. Requests resume after 20 ms even if the I/O is still
  running, and the worker then asks for another catch-up, since a write admitted later may
  have missed it.

SQLite's `synchronous` setting is left at its default, and the checkpoint worker never
changes WAL bytes outside SQLite. `journal_size_limit` caps the WAL file kept after
checkpoints; it is not a limit on an active transaction, and a reader holding old frames
delays the shrink until a later checkpoint.

Code that opens `Store` directly, such as `scripts/seed-demo.mjs`, keeps SQLite's automatic
checkpoints every 256 pages.

## Tests

The storage format has its own tests, run by `npm test` (see [testing.md](testing.md)):
`history-codec`, `history-store`, `storage-golden` (chart and export output compared against
hashes captured before format 2), `storage-maintenance`, `db-checkpoint`, `db-contention`
and `schema-upgrade`. `npm run test:sdk` ends with a restart test that stops the server for
90 seconds while the real SDK logs, and checks that no rows are missing or duplicated.
