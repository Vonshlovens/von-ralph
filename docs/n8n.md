# Driving ralph from n8n

n8n talks to `ralph serve` over HTTP and waits for a callback; it never runs
shell commands. A run is a detached ralph process, so it keeps going if n8n or
the server restarts.

## 1. Run the server

```bash
# Loopback only (n8n on the same machine):
ralph serve                                   # http://127.0.0.1:7420

# Reachable from n8n elsewhere on the tailnet: a token is required.
export RALPH_SERVE_TOKEN=$(openssl rand -hex 24)
ralph serve --host 0.0.0.0
```

As a systemd user service (`~/.config/systemd/user/ralph-serve.service`):

```ini
[Unit]
Description=ralph serve

[Service]
ExecStart=%h/.local/bin/ralph serve --host 0.0.0.0
Environment=RALPH_SERVE_TOKEN_FILE=%h/.config/ralph/serve-token
# The harness CLIs and hc must be on PATH:
Environment=PATH=%h/.local/bin:%h/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin
Restart=on-failure

[Install]
WantedBy=default.target
```

`systemctl --user enable --now ralph-serve` (and `loginctl enable-linger $USER`
so it runs without a login session).

## 2. The workflow

1. **HTTP Request** — `POST http://<host>:7420/v1/runs`
   - Header `Authorization: Bearer <token>`
   - JSON body:

     ```json
     {
       "mode": "build",
       "dir": "~/repos/api",
       "max": 10,
       "callbackUrl": "={{ $execution.resumeUrl }}"
     }
     ```

   - `mode`: `run` (needs `prompt`), `plan`, `build`, `reverse`. Optional:
     `name`, `harness`, `model`, `effort`, `max`, `timeout` (minutes per
     iteration), `marathon`, `bead`, `scope`.
   - Answers `201 {"run": {...}}` once the run has registered (or `400` with
     `{"error": …}`, e.g. the project is not initialized).

2. **Wait** — Resume: _On Webhook Call_, HTTP method `POST`. Set a "Limit Wait
   Time" a bit above the run's worst case.

3. When the run ends, ralph POSTs the summary to the resume URL and the
   workflow continues with it as `$json.body`:

   ```json
   {
     "event": "run_finished",
     "reason": "plan_complete",
     "exitCode": 0,
     "needsHuman": false,
     "run": { "id": "r…", "name": "build-api", "status": "finished", "...": "…" },
     "report": {
       "iterations": 6,
       "commits": ["abc1234 Add billing webhooks", "…"],
       "validate": { "runs": 6, "failures": 0, "last": { "ok": true, "...": "…" } },
       "plan": { "before": { "open": 6 }, "after": { "open": 0, "ready": 0 } },
       "needsHuman": [],
       "lastWords": "…",
       "costUsd": 0
     }
   }
   ```

4. **IF** `{{ $json.body.needsHuman }}` → notify (ntfy, Slack, email) with
   `report.needsHuman` and a link to the run; otherwise carry on (open a PR,
   start the next stage, …).

`exitCode` matches the CLI: 0 done, 3 ended but needs a human, 1 failed,
130 interrupted.

### Without a callback

`GET /v1/runs/<name>/wait?timeout=600` long-polls until the run ends (returns
`{"done": true|false, "run": …}`); loop on `done`. Fine for short runs; the
resume-URL pattern is better for long ones.

## Verifying callbacks

Set `RALPH_CALLBACK_SECRET` (or `RALPH_CALLBACK_SECRET_FILE`) wherever runs
start — in `ralph serve`'s environment for API-started runs. Each callback then
carries:

- `X-Ralph-Timestamp: <unix seconds>`
- `X-Ralph-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">`

In n8n, check it in a Code node with `crypto.createHmac`, and reject stale
timestamps.

## Other endpoints worth using from a workflow

| Endpoint                       | Use                                          |
| ------------------------------ | -------------------------------------------- |
| `POST /v1/runs/:id/steer`      | `{"text": "…"}` added to the next iteration  |
| `POST /v1/runs/:id/stop`       | `{"graceful": true}` stops after this one    |
| `GET /v1/runs/:id/report`      | the same summary as the callback, any time   |
| `POST /v1/schedules/:name/run` | kick off a `ralph schedule` entry right away |
