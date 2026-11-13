# Deployment and operation

randl is one Node.js process. It serves the dashboard, the W&B SDK protocol, the tools API and
file transfers on a single port, and keeps everything in one data directory. This guide covers
hosting it beyond a workstation, backing it up, and upgrading and rolling back.

## On a workstation

```sh
npm ci
npm run build
npm start
```

The server listens on `127.0.0.1:8742` without an API key, so local access needs no login. Do
not expose this listener to other users.

## With an API key behind HTTPS

To use randl from other machines, give it an owner API key and put it behind an HTTPS reverse
proxy. Each server has one owner, and the key grants full access to data, settings and plugin
management.

```sh
export RANDL_API_KEY="$(openssl rand -hex 32)"
export RANDL_PUBLIC_URL=https://randl.example.com
npm start -- --host 127.0.0.1 --data-dir /srv/randl
```

- The server refuses a remote configuration without an API key and an HTTPS public URL.
- The proxy forwards to `127.0.0.1:8742` and preserves the public `Host` header.
- The browser signs in with the key and gets an expiring, HTTP-only, `SameSite=Strict` session
  cookie (`Secure`, with the `__Host-` prefix, over HTTPS). Logging out revokes the session;
  changing the key and restarting revokes all of them.
- Keep the key in a secret store. Do not put it in source code, command lines, URLs or reports.

Clients use the same key:

```sh
export WANDB_BASE_URL=https://randl.example.com
export WANDB_API_KEY="$RANDL_API_KEY"
export RANDL_URL=https://randl.example.com
```

SDK file transfers use expiring signed URLs scoped to one method and path; treat them as
temporary credentials.

### Caddy

[deploy/Caddyfile](../../deploy/Caddyfile) forwards HTTPS to randl's loopback listener:

```sh
export RANDL_DOMAIN=randl.example.com
caddy run --config deploy/Caddyfile
```

DNS must point to the server and ports 80 and 443 must be reachable for the certificate. Other
proxies work the same way: a loopback upstream and the public `Host` header. Make sure the
proxy's timeouts and body limits fit your largest uploads.

### Running as a service

Run randl under a dedicated, unprivileged account with a data directory only it can read. A
systemd unit, for example:

```ini
[Unit]
Description=randl
After=network.target

[Service]
User=randl
WorkingDirectory=/opt/randl
EnvironmentFile=/etc/randl.env
ExecStart=/usr/bin/node backend/dist/cli.js serve --host 127.0.0.1 --port 8742 --data-dir /srv/randl --frontend-dir /opt/randl-frontend
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`/etc/randl.env` holds `RANDL_API_KEY` and `RANDL_PUBLIC_URL`. SIGTERM shuts the server down
cleanly.

`--frontend-dir` serves a deployed copy of `frontend/dist`, so rebuilding the checkout does
not change the running dashboard until you copy the new build.

## The data directory

| Path            | Contents                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------- |
| `randl.sqlite3` | Runs, history, views, the ledger, settings and the audit log (WAL mode: `-wal`, `-shm` too) |
| `files/`        | Run files and logged media                                                                  |
| `artifacts/`    | Artifact files                                                                              |
| `plugins/`      | Installed panel plugins, one folder per plugin                                              |
| `pi/`           | The Assistant's profile, including provider keys                                            |
| `cache/`        | Video posters; safe to delete                                                               |

## Data and limits

- JSON requests are limited to 32 MiB and file uploads to 10 GiB per file. Interrupted
  uploads never replace completed files.
- Each run keeps at most 500 MiB of media by default. A run over the limit, finished or not,
  permanently loses media entries, thinned evenly over its steps. Set the limit in **App
  settings → Storage**, or per project in **Settings → Media limit**. To see what it would
  remove:

  ```sh
  randl tool media_limit_apply --json '{"dryRun": true}'
  ```

- A running run with no SDK contact for `--run-timeout` seconds (default 600) is marked
  crashed; renewed contact returns it to running.
- With `ffmpeg` on `PATH` (or `RANDL_FFMPEG` set to its path), randl makes video posters. Set
  `RANDL_FFMPEG=off` to disable them.

## Backups

Back up the whole data directory: the database and the files belong together.

**With a short stop** (simplest and always consistent):

```sh
systemctl stop randl
tar -C /srv -czf /backups/randl-$(date +%F).tar.gz randl
systemctl start randl
```

**While it runs:** copy the database with SQLite's online backup, which is consistent even
during writes, then the files. Never copy only a live `randl.sqlite3` without its WAL.

```sh
sqlite3 /srv/randl/randl.sqlite3 ".backup /backups/randl-$(date +%F).sqlite3"
rsync -a /srv/randl/files /srv/randl/artifacts /srv/randl/plugins /srv/randl/pi /backups/randl-files/
```

Files uploaded between the two steps can be missing from the copy; for a backup you may need to
restore exactly, stop the server.

To restore, stop the server, replace the data directory with the backup and start it.

## Upgrades

1. **Update and build:**

   ```sh
   git pull
   npm ci
   npm run build
   npm run check && npm test
   ```

2. **Back up** the data directory (above).
3. **Deploy the dashboard** if you serve a copy:
   `rsync -a --delete frontend/dist/ /opt/randl-frontend/`.
4. **Restart** the server on the same port.
5. **Verify:** `curl -s http://127.0.0.1:8742/api/health` returns `{"ok": true, …}`;
   `randl status` and `randl projects list` answer; the dashboard loads; a running run is still
   receiving data.

The backend and the dashboard are versioned together: when a change touches the API, deploy
both.

### Schema changes

At startup the server creates missing tables and adds missing columns to existing ones; it never
drops or rewrites columns. Some startup steps convert stored records to a newer shape (for
example, plans saved with a host and slot gain a GPU request). The database records its storage
format, and the server refuses a data directory in a format it does not support rather than
guessing.

### Rolling back

1. Stop the server.
2. Check out and build the previous version (or restore the previous dashboard copy).
3. If the newer version converted stored data, restore the backup taken before the upgrade;
   added tables and columns alone do not stop an older build from running.
4. Start the server and verify as above.

Changes made between the upgrade and the restore are lost with the restore; export anything you
need first with the CLI.

## Security notes

- Installed panel plugins run in the dashboard with access to all its data; enable only code
  you trust. randl never runs plugin install or build scripts.
- The API key also manages plugins, so do not hand it out as a read-only credential.
- TLS certificates, firewall rules, OS updates, disk space, backups and key rotation are yours
  to manage.
