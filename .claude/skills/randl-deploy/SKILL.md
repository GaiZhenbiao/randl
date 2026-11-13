---
name: randl-deploy
description: Build, test, back up and redeploy a randl server on its single port, verify it, and roll back - including rehearsing a change against a copy of the data on a spare port first. Use when asked to deploy, upgrade, restart, back up or roll back randl, or to test a change against real data without touching the live server.
---

# Deploying randl

randl is one Node.js process serving the dashboard, SDK, tools API and file transfers on one
port, with one data directory. Details: [deployment guide](../../../docs/guides/deployment.md),
[configuration](../../../docs/reference/configuration.md).

> **Finding the docs.** Links here are relative to the randl repository, where this skill lives
> in `.claude/skills/randl-deploy/`. If the skill was loaded through a symlink (for example from
> `~/.claude/skills/randl-deploy`), a link may not resolve: resolve the symlink to the checkout with
> `readlink -f ~/.claude/skills/randl-deploy/SKILL.md`, then read `docs/` at the root of that
> checkout (`git -C "$(dirname "$(readlink -f ~/.claude/skills/randl-deploy/SKILL.md)")" rev-parse --show-toplevel`).

Before starting, find out from the user (do not guess): the checkout path, the data directory,
the port, how the server is started (service unit, script, or `randl serve` options), and
whether a separate dashboard copy is served with `--frontend-dir`. Training runs may be logging
to the live server: a restart interrupts their uploads briefly (the SDK retries), so ask before
restarting.

## 1. Build and test in the checkout

```sh
git status --short                 # nothing unexpected
npm ci
npm run build
npm run check
npm test
```

Run the browser suites that cover the change (`npm run test:<area>`; see
[testing](../../../docs/contributing/testing.md)). Do not deploy with failing tests.

## 2. Rehearse on a copy (when the change touches stored data)

Never point tests or experiments at the live server. Start a second server on a spare port
against a copy of the data:

```sh
mkdir -p /tmp/randl-rehearsal
sqlite3 /srv/randl/randl.sqlite3 ".backup /tmp/randl-rehearsal/randl.sqlite3"
node backend/dist/cli.js serve --port 8799 --data-dir /tmp/randl-rehearsal
```

Check the change there (`RANDL_URL=http://127.0.0.1:8799`), then stop it.

## 3. Back up

```sh
STAMP=$(date +%Y%m%d-%H%M%S)
sqlite3 /srv/randl/randl.sqlite3 ".backup /backups/randl-$STAMP.sqlite3"
cp -a /opt/randl-frontend /backups/randl-frontend-$STAMP     # if a dashboard copy is served
git rev-parse HEAD > /backups/randl-$STAMP.commit
```

`.backup` is consistent while the server runs. Copying `randl.sqlite3` alone with `cp` is not
(it misses the WAL). For a full restore point also copy `files/`, `artifacts/`, `plugins/` and
`pi/`, or stop the server and copy the whole directory.

## 4. Restart on the same port

With a service manager:

```sh
systemctl restart randl
```

Without one, stop the process that holds the port and start the new build:

```sh
ss -ltnp 'sport = :8742'                     # note the pid
kill PID                                      # SIGTERM shuts down cleanly
while ss -ltn 'sport = :8742' | grep -q LISTEN; do sleep 1; done
setsid nohup node backend/dist/cli.js serve --port 8742 --data-dir /srv/randl >> randl.log 2>&1 < /dev/null &
```

- Find the process by its port. Do not `pkill -f` a pattern: it can match your own shell.
- If you serve a dashboard copy, update it in the same deploy as the backend when the API
  changed: `rsync -a --delete frontend/dist/ /opt/randl-frontend/`.

## 5. Verify

```sh
curl -fsS http://127.0.0.1:8742/api/health          # {"ok":true,…}
RANDL_URL=http://127.0.0.1:8742 node backend/dist/cli.js status
RANDL_URL=http://127.0.0.1:8742 node backend/dist/cli.js projects list
```

Then: the dashboard loads; a running run's charts still update; the server log shows no errors
since the restart. Report the commit deployed and the checks that passed.

## 6. Roll back

1. Stop the server (as in step 4).
2. `git checkout <previous commit>` and `npm ci && npm run build`, or restore the backed-up
   dashboard copy.
3. Only if the new version converted stored data, restore the database backup:
   `cp /backups/randl-$STAMP.sqlite3 /srv/randl/randl.sqlite3` and remove the `-wal` and `-shm`
   files beside it. Changes made since the backup are lost; say so first.
4. Start and verify as above.

Startup only adds tables and columns, so an older build normally runs on a newer database;
restoring is for data the newer version rewrote.

## Checklist

- [ ] Tests passed on the commit being deployed.
- [ ] Backup taken and its path noted.
- [ ] Restarted on the same port; old process gone.
- [ ] Health, CLI and dashboard checks passed; reported to the user.
