# orca-notify

Get a webhook call when a coding agent running in Orca finishes, gets blocked, or waits for input.

orca-notify is a small background listener for macOS. It connects to your local Orca app as a paired device, subscribes to Orca's notification stream, and when a pane you are **watching** reports `done` / `blocked` / `waiting` (or an `agent-task-complete` event), it POSTs a JSON event to a webhook of your choice.

Use it to wake a bot or automation (for example a Grok Bot / Cursor automation webhook), push to your phone via ntfy / Pushover / a Slack incoming webhook, or call your own server. Any HTTPS endpoint that accepts a JSON POST works.

> ⚠️ **Unofficial.** orca-notify loads Orca's *internal* client module from inside the app bundle
> (`Orca.app/Contents/Resources/app.asar.unpacked/out/shared/remote-runtime-client`). It is not a public API and **may break when Orca updates**.
> Tested with Orca **1.4.240** and **1.4.241**.

## How it works

```
Orca app (ws://127.0.0.1:<port>)  ──notifications.subscribe──▶  listener.js  (launchd, KeepAlive)
                                                                   │ match watch.json (pane key / term_ handle)
                                                                   │ pick target (routes.json)
                                                                   ▼
                                                     wake.sh ── POST JSON + Bearer key ──▶ your webhook
```

- Runs under Orca's bundled runtime (`ELECTRON_RUN_AS_NODE=1 Orca.app/Contents/MacOS/Orca listener.js`), so no separate Node install is needed. Falls back to `node` on `PATH`.
- On every (re)connect it catches up with `notifications.getMissedSince`, and de-duplicates by notification seq/epoch. A restart or a short disconnect does not lose events.
- Watched panes are identified either by Orca pane key (`<tabId>:<leafId>`) or by a terminal handle (`term_…`, resolved through `terminal.list`).

## Requirements

- macOS with Orca installed in `/Applications/Orca.app` (or set `ORCA_APP`)
- Orca running on the same Mac
- `curl` and `launchctl` (built in)

## Install

```bash
git clone https://github.com/xinnyu/orca-notify.git
cd orca-notify
./install.sh                     # installs to ~/.orca-notify, CLI to ~/.local/bin/orca-notify
# options: --dir <dir>  --label <launchd label, default dev.orca-notify>  --bin <dir>  --no-launchd
```

The installer copies the scripts, writes `~/Library/LaunchAgents/<label>.plist`, and loads it with `launchctl bootstrap`. Make sure `~/.local/bin` is on your `PATH`.

Uninstall: `./uninstall.sh [--label <label>]`, then delete `~/.orca-notify` if you no longer need it.

## Pairing with Orca

The listener needs a device credential for your local Orca runtime. orca-notify gets it from an Orca **pairing code** (`orca://pair?code=…`). This is the same code the Orca mobile app or `orca environment add --pairing-code` uses.

1. In the Orca desktop app, open the device pairing screen (Settings → mobile / remote device pairing) and create a pairing code. Copy the `orca://pair?code=…` link instead of scanning the QR code. Pairing codes expire after about 10 minutes.
2. Run:
   ```bash
   orca-notify pair          # paste the code when prompted
   orca-notify restart
   orca-notify status        # should show "paired: yes"; `orca-notify tail` should show "subscribed"
   ```

`pair` decodes the code with Orca's own decoder (`out/shared/pairing.js`) and saves it as `~/.orca-notify/.pairing.json` (mode 600). It rewrites the endpoint host to `127.0.0.1` because the listener runs on the same Mac. Set `ORCA_NOTIFY_KEEP_ENDPOINT=1` to keep the original host.

> The exact menu name of the pairing screen differs between Orca versions. If your code goes through a relay rather than a direct `ws://` endpoint, or decoding fails, see Troubleshooting.

## Targets (where events go)

```bash
orca-notify target add bot https://example.com/automations/webhook/<id>   # prompts for the bearer key (hidden)
echo "$KEY" | orca-notify target add bot https://…                        # or pipe it on stdin
orca-notify target add phone https://ntfy.sh/my-topic --no-key            # endpoint without auth
orca-notify target default bot
orca-notify target list
orca-notify target remove phone
orca-notify test [target]                                                  # send a sample event
```

Keys are written to `~/.orca-notify/keys/<name>.key` (mode 600) and are sent as `Authorization: Bearer <key>`. They never appear in a command line.

### Routing

The target for a matched event is chosen in this order:

1. `--target` set on the watch entry
2. `byWorktree[<worktreeId>]` in routes.json (`orca-notify route worktree <id> <target>`)
3. `byRepo[<repoId>]` in routes.json (`orca-notify route repo <id> <target>`; used only if the notification carries a `repoId`)
4. `default`

See `examples/routes.example.json` and `examples/watch.example.json`.

## Watching panes

```bash
orca-notify watch add term_abc123 "backend refactor"            # terminal handle (from `orca terminal list`)
orca-notify watch add <tabId>:<leafId> "docs agent" --target phone
orca-notify watch list
orca-notify watch remove term_abc123
```

Only watched panes trigger webhooks. Every notification is still logged to `listener.log`, which helps you find a pane key. Matched events are also appended to `events.jsonl`.

Set `ORCA_NOTIFY_STATES` (comma list, default `done,blocked,waiting`) in the plist's environment to change which agent states trigger.

## Payload

`POST <url>`, `Content-Type: application/json`, optional `Authorization: Bearer <key>`:

```json
{
  "time": "2026-01-01T12:00:00.000Z",
  "label": "backend refactor",
  "watchKey": "term_abc123",
  "agentState": "done",
  "title": "Agent finished",
  "body": "…",
  "paneKey": "tab-1:leaf-2",
  "worktreeId": "…",
  "seq": 42,
  "source": "agent-task-complete"
}
```

Any 2xx response counts as success. Failures show up in the log. Events are not retried, but they stay in `events.jsonl`.

## Files

| Path (`~/.orca-notify/`) | Purpose |
|---|---|
| `listener.js`, `run.sh`, `wake.sh`, `pair.js`, `orca-notify` | code |
| `.pairing.json` | Orca device credential (**secret**, 600) |
| `keys/*.key` | webhook bearer keys (**secret**, 600) |
| `routes.json`, `watch.json` | config |
| `state.json`, `events.jsonl`, `listener.log` | runtime state / logs |

## Troubleshooting

- **`connect failed (Orca not running / not paired?)`**: start Orca, then check `.pairing.json` exists and run `orca-notify pair` again with a new code.
- **`Cannot find module …/remote-runtime-client`**: your Orca version moved its internals. Set `ORCA_OUT_DIR` to the `out` directory, or open an issue.
- **Pairing decode fails / no `deviceToken`**: the code may be relay-only or from an unsupported version. Check that it starts with `orca://pair?code=` and is less than 10 minutes old.
- **Nothing fires**: check `orca-notify tail 50`. Confirm the pane key/handle in the log matches `watch list`, and that a target or default exists (`target list`).
- **Webhook non-2xx**: run `orca-notify test <target>` and check the URL and key.
- **Service state**: `orca-notify status`, `orca-notify restart`, `launchctl print gui/$(id -u)/dev.orca-notify`.

## Security notes

- `.pairing.json` grants control of your Orca runtime (terminals, agents). Treat it like an SSH key: keep it at mode 600, never commit it. To revoke access, remove the paired device in Orca.
- Webhook keys live in separate 600 files and are passed to curl through a file descriptor, so they never show up in `ps`.
- Event payloads include agent titles and bodies, which may contain code or paths. Only send them to endpoints you trust, over HTTPS.
- `.gitignore` excludes all secrets, state and logs.

## 中文说明

orca-notify 是一个 macOS 后台监听器：以「已配对设备」身份连接本机 Orca，订阅通知流。被 watch 的 pane 里的 agent 完成、卡住或等待输入时，它会向你配置的 webhook POST 一条 JSON 事件，可用来唤醒 Grok Bot / Cursor 自动化，或推送到手机、Slack 等。

- 安装：`./install.sh`，装到 `~/.orca-notify`，launchd 常驻，label 默认 `dev.orca-notify`。
- 配对：在 Orca 设置里生成配对码 `orca://pair?code=…`，然后运行 `orca-notify pair` 粘贴配对码，再运行 `orca-notify restart`。
- 目标：`orca-notify target add <名字> <url>`，key 从 stdin 读入，存为 600 权限文件。支持多个目标，可按 watch、worktree、repo 分别路由，也可设默认目标。
- 监听：`orca-notify watch add <term_句柄 或 tabId:leafId> [标签] [--target 名字]`。
- 注意：本工具依赖 Orca 内部模块，不是公开 API，Orca 升级后可能失效。已在 1.4.240 和 1.4.241 上测试。`.pairing.json` 等同于控制 Orca 的凭证，切勿泄露。

## License

MIT
