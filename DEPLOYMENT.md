# Hosting randl

randl can run on your workstation, another machine or an internet-facing server. Each
server has one owner, and its API key grants full access to data and settings.

## Workstation

```sh
npm ci
npm run build
npm start
```

The default listener is `127.0.0.1:8742`. Without an API key, local access needs no
login. Do not forward this unauthenticated listener to other users.

## Authenticated hosting

Generate a key and keep it in a password manager or your server's secret store:

```sh
export RANDL_API_KEY="$(openssl rand -hex 32)"
export RANDL_PUBLIC_URL=https://randl.example.com
npm start -- --host 127.0.0.1
```

Replace the example domain with yours. Configure an HTTPS reverse proxy to send
requests to `127.0.0.1:8742` and preserve the public `Host` header; clients connect to
the public HTTPS URL. The server refuses a remote configuration without an API key and
an HTTPS public URL.

The browser signs in with the API key and receives an expiring, HTTP-only,
`SameSite=Strict` session cookie (`Secure` with the `__Host-` prefix over HTTPS). Raw
session tokens are not stored. Logging out revokes the session; changing the API key
and restarting revokes all sessions.

SDK and CLI clients use the same key:

```sh
export WANDB_BASE_URL=https://randl.example.com
export WANDB_API_KEY="$RANDL_API_KEY"
python train.py

export RANDL_URL=https://randl.example.com
npm run randl -- status
```

On other machines, supply the key through that machine's secret store or environment.
Do not put it in source code, command-line arguments, URLs or reports. SDK file
transfers use expiring signed URLs scoped to one method and path; treat them as
temporary credentials too.

## Reverse proxy with Caddy

[deploy/Caddyfile](deploy/Caddyfile) forwards HTTPS requests to randl's loopback
listener. For a foreground test with Caddy installed, run in another terminal:

```sh
export RANDL_DOMAIN=randl.example.com
caddy run --config deploy/Caddyfile
```

If Caddy already runs as a service, configure that service with the supplied file
instead. Run randl with the matching `RANDL_PUBLIC_URL` and owner key as shown above.
DNS must point to the server, and ports 80 and 443 must be reachable for Caddy's
certificate setup. Configure your process manager to start both services with their
environment variables, and set randl's working directory to the checkout or pass an
absolute `--data-dir`. The [Caddy service guide](https://caddyserver.com/docs/running#linux-service)
covers running Caddy as a service. Other HTTPS reverse proxies work the same way: use
the loopback upstream and preserve the public `Host` header.

Use `--frontend-dir DIR` to serve a deployed copy of `frontend/dist`, so rebuilding the
checkout does not change the running app.

## Data and operation

- The data directory (`--data-dir`, default `.data`) holds the SQLite database, uploaded
  files, installed plugins and the Assistant profile. Back up the whole directory. For a
  simple filesystem backup, stop randl first so SQLite and its write-ahead log are
  consistent; do not copy only a live `randl.sqlite3` file.
- Keep the data directory writable by the server user and inaccessible to other users.
  Run randl under a dedicated, unprivileged account.
- JSON API requests are limited to 32 MiB and file uploads to 10 GiB per file. Make sure
  your reverse proxy's timeouts and body limits fit your model files. Interrupted
  uploads never replace completed files.
- A running run with no SDK contact for `--run-timeout` seconds (default 600, minimum 60)
  is marked crashed; renewed contact returns it to running.
- With `ffmpeg` on `PATH` (or `RANDL_FFMPEG` set to its path), randl makes video poster
  images and caches them under `cache/posters/` in the data directory. Set
  `RANDL_FFMPEG=off` to disable it; browsers then draw the first frame themselves.
- External plugins run trusted browser code, and the API key also grants plugin
  management, so do not share it as a read-only credential.
- TLS certificates, firewall rules, OS updates, disk capacity, backups and key rotation
  remain your responsibility.

## Assistant provider setup

The Assistant is optional. Each data directory has its own Pi profile at
`<data-dir>/pi/`, created with owner-only permissions. In **App settings → Assistant**,
save a provider API key and choose a model. Keys are stored unencrypted in
`<data-dir>/pi/auth.json` (mode `0600`), so backups of the data directory include them.
Prompts and tool results are sent to the selected model's provider, and **Test
connection** sends a short request that may be billed.

Providers that need an OAuth sign-in or extra credential fields are configured with the
Pi CLI on the server: expand **Sign in or configure with Pi**, copy the command, enter
`/login` in Pi, then choose **Refresh providers** in randl. Custom endpoints belong in
the profile's `models.json`.

To share credentials and defaults with an existing Pi installation, pass its profile
directory:

```sh
npm run randl -- serve --pi-agent-dir /path/to/pi/profile
```

`RANDL_PI_AGENT_DIR` sets the same option. Provider environment variables such as
`OPENAI_API_KEY` remain available to Pi. With a shared profile, saving or removing keys
in randl also changes that profile.

The Assistant loads only randl's management tools. It does not load project
instructions, skills, extensions, or shell and file tools from the server's working
directory.
