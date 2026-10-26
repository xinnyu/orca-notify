# Agent Notify (`agent-notify`)

*(Listed in Orca as **Orca Notify**; its commands start with "Orca Notify:".)*

**An Orca plugin that sends a webhook when a coding agent finishes, gets blocked, or waits for your input. You get exactly one notification per finished task.**

It works with any URL that accepts a JSON `POST`: Grok Bot or Cursor automation webhooks, Slack or Discord incoming webhooks, ntfy, or your own server.

## Before you start

- **Orca 1.4.240 or newer.** Orca's plugin system is still marked *Experimental*.
- **The plugin system must be on:** Orca → Settings → **Plugins** → **Plugin system**.
- **Command palette:** you run the plugin's commands from it with **Cmd+J** (Ctrl+J on Windows/Linux).
- **The webhook must be reachable from the Mac running Orca.** Webhooks are sent from that Mac, not from a server.

## Quickstart (3 steps)

**1. Install the plugin.** Go to Settings → Plugins → **Install plugin** → **Git URL** and enter:

```
https://github.com/xinnyu/orca-notify.git#v1.3.0
```

Click **Install**, review the permissions, then click **Enable plugin**.

**2. Add your webhook.** Use either option.

*Option A: edit one file.* Create `~/.orca-notify/config.json`:

```json
{ "url": "https://example.com/hooks/abc" }
```

If the endpoint needs a bearer token, save it in `~/.orca-notify/keys/default.key`. The plugin moves it into Orca's encrypted vault and deletes the file.

*Option B: use the helper script* (a plain bash script with no dependencies):

```bash
mkdir -p ~/.local/bin
curl -fsSL https://raw.githubusercontent.com/xinnyu/orca-notify/v1.3.0/bin/agent-notify -o ~/.local/bin/agent-notify
chmod +x ~/.local/bin/agent-notify          # make sure ~/.local/bin is on your PATH
agent-notify add-target mybot https://example.com/hooks/abc        # prompts for a bearer key (Enter = none)
agent-notify add-target slack https://hooks.slack.com/services/... --format slack --no-key
```

The **first target you add becomes the default**, and every agent reports to it. Add `--default` to make a later target the default.

**3. Test.** In Orca, press **Cmd+J** and run **Orca Notify: Send test event to all targets**. A desktop notification shows `OK` or the reason for the failure for each target.

The plugin picks up changes automatically each time it starts, which happens on the next agent event or when you run any of its commands.

## What gets sent

`POST <url>` with `Content-Type: application/json`, plus `Authorization: Bearer <key>` if the target has a key.

```json
{
  "time": "2026-01-01T12:00:00.000Z",
  "label": "myapp/main",
  "watchKey": null,
  "agentState": "done",
  "title": "Agent done: myapp/main",
  "body": null,
  "paneKey": "<tabId>:<leafId>",
  "worktreeId": "<repoId>::/path/to/worktree",
  "seq": 42,
  "source": "orca-plugin",
  "mainAgent": { "state": "done", "stateStartedAt": 1767268800000 }
}
```

- **Formats:**
  - `"format": "slack"` sends `{ "text": "Agent done: myapp/main", "orca": { …the payload above… } }`.
  - `"format": "discord"` sends `{ "content": "Agent done: myapp/main" }`.
- **When it fires:**
  - `done` or `waiting` fire only after the pane was seen `working`. That gives one notification per task and skips the idle "done" a new session reports.
  - `blocked` fires immediately.
- **Delivery:**
  - Requests time out after 5 s. 5xx, 429 and network errors are retried twice.
  - Each delivery runs in the background, so a dead target never delays the others.
  - Failures show a desktop notification. A 401 or 403 tells you to re-add the key.

## Routing (optional)

```json
{
  "defaultTarget": "mybot",
  "targets": {
    "mybot":  { "url": "https://example.com/hooks/abc" },
    "slack":  { "url": "https://hooks.slack.com/services/...", "format": "slack", "noKey": true }
  },
  "rules": [
    { "repoId": "b0366c5a-0000-0000-0000-000000000000", "target": "slack", "label": "side project" },
    { "pathPrefix": "/Users/me/Project/app", "target": "mybot" },
    { "worktreeId": "<repoId>::/path/to/worktree", "mute": true },
    { "paneKey": "<tabId>:<leafId>", "target": "mybot", "label": "long refactor" }
  ],
  "states": ["done", "blocked", "waiting"],
  "watch": "all"
}
```

- **Which rule applies:** the most specific match wins, in this order: `paneKey`, `worktreeId`, `pathPrefix`, `repoId`. If nothing matches, the event goes to `defaultTarget`.
- **Finding ids:**
  - Every event carries `worktreeId` = `<repoId>::<worktree path>`. **`repoId` is the part before `::`**, so a `repoId` rule covers all worktrees of a repo.
  - After any agent has run, use **Cmd+J → Orca Notify: Show last agent event** to see the latest `worktreeId` and `paneKey`.
  - If you have the `orca` CLI installed, `orca repo list` prints repo ids.
  - `pathPrefix` needs no id at all: it matches by folder.
- **`watch: "listed"`** only notifies for panes, worktrees or repos that match a rule or a watch (below).

## Watches: register panes from scripts and bots (v1.3.0)

With `"watch": "listed"`, bots used to register panes by editing `rules` in `config.json`. Two bots doing that at once could overwrite each other. Use the watch registry instead:

```bash
agent-notify watch <paneKey> [--label "long refactor"] [--target mybot] [--ttl 24h] [--once]
agent-notify watch --worktree <worktreeId> | --path <folder> | --repo <repoId>   # same options
agent-notify unwatch <paneKey>          # or --worktree / --path / --repo
agent-notify list                       # every watch with its age and time left
agent-notify prune                      # delete expired watches now
agent-notify migrate-rules              # move paneKey rules from config.json into the registry
```

- **No lost updates:** each watch is its own file in `~/.orca-notify/watch/` (mode 600), written to a temp file and renamed into place. The file name is derived from the key, so watching the same pane twice just replaces the entry. Nothing is read-modify-written, so any number of parallel `watch` calls all survive (the test suite runs 50 at once).
- **Applies immediately:** the plugin re-reads the folder on every event. Watches work exactly like `rules` with the same key and are checked before them. `rules` in `config.json` still work.
- **No zombie entries.** Several things clean up stale watches:
  - **TTL:** every watch expires, by default 24 h after it was last renewed. Change the default with `"watchTtlHours"` in `config.json`, or per watch with `--ttl 30m|12h|2d`. Each `working` report from the pane renews its watch, so long tasks don't expire. The expiry time is the file's mtime.
  - **Worktree removed:** when Orca removes a worktree (`worktree.removed` event), the plugin deletes watches for that worktree, its path, and the panes last seen in it. Orca's plugin API has no "pane closed" or "tab closed" event, so watches on panes that are closed while the worktree stays rely on the TTL.
  - **`--once`:** deletes the watch after its first `done` notification. This is off by default because an agent in a pane often runs several tasks.
  - **Pruning:** the plugin prunes at startup, on every event, and every 10 minutes while it runs. It also deletes unreadable entries and leftover temp files older than a minute. `agent-notify list`, `status` and `prune` prune too.
- **Migrating:** paneKey rules left in `config.json` keep working. To move them into the registry, run `agent-notify migrate-rules`. It writes the watch files first, then rewrites `config.json` atomically without those rules. Other rules stay. Do this only after v1.3.0 of the plugin is running, because older versions don't read the registry. `migrate-rules` needs `node` or Orca.app.

## Example: wake a Grok Bot / Cursor automation

Create a webhook-triggered routine or automation and copy its URL and secret. Then run:

```bash
agent-notify add-target bot https://<automation-webhook-url> --default   # paste the secret when prompted
```

The bot receives the JSON payload above and can act on `worktreeId`.

## Commands

| In Orca (Cmd+J) | What it does |
|---|---|
| Orca Notify: Show status | Reloads the config, imports keys, and shows the targets, the default target and the rule count |
| Orca Notify: Send test event to all targets | Sends a test event to every target in parallel and reports OK or the failure reason for each |
| Orca Notify: Show last agent event | Shows the ids you need for writing rules |

| Helper script | What it does |
|---|---|
| `agent-notify add-target <name> <url> [--default] [--format generic\|slack\|discord] [--no-key]` | Add or replace a target |
| `agent-notify remove-target <name>` | Remove a target and delete its stored key |
| `agent-notify remove-key <name>` | Delete a key file that hasn't been imported yet |
| `agent-notify status` | Show the config with URLs redacted, pending changes and the watch count. Never prints keys |
| `agent-notify watch <paneKey>` / `unwatch` / `list` / `prune` / `migrate-rules` | Manage the watch registry (see [Watches](#watches-register-panes-from-scripts-and-bots-v130)) |

## Security

- Bearer keys are imported into Orca's encrypted per-plugin vault, and the plaintext files are deleted.
- **Slack and Discord webhook URLs are secrets themselves, and they are stored in plaintext** in `~/.orca-notify/config.json` (mode 600). Treat that file like a password.
- The payload contains ids and agent state, but no prompts or code.

## Troubleshooting

- **"Plugin installation failed. Check the source and try again."**
  - Make sure the URL ends in a tag such as `#v1.3.0` and the plugin system is on.
  - Plugin authors: Orca reserves plugin ids that start with `orca-`, and the publisher `stablyai`, for official plugins. Installs of such ids fail with only this generic message.
- **Test works but real events don't arrive:**
  - Check that the plugin shows **Enabled** or **Running** in Settings → Plugins.
  - Open **… → View logs** on the plugin's card. Every skipped event is logged with the reason.
- **"no webhook configured" / "config.json is invalid":** follow the message. The second one includes the JSON parse error.
- **401 or 403:** the key is wrong. Run `agent-notify add-target <same name> <url>` again.
- **Permissions:** Orca asks once for *agent status events*, *encrypted secrets*, *plugin storage* and *desktop notifications*.
- **Upgrade:** run **Install plugin** again with the new `#tag`. Your config and keys are kept.

## Uninstall

1. Settings → Plugins → Orca Notify → **…** → **Remove**. Orca deletes the plugin and its data folder, including the encrypted vault with your keys.
2. `rm -rf ~/.orca-notify`. This deletes the config and any key files not yet imported.

To remove only one target and its key, use `agent-notify remove-target <name>`.

## Development

```bash
node --test test/*.test.mjs                                                           # unit + CLI tests (no Orca needed)
ELECTRON_RUN_AS_NODE=1 /Applications/Orca.app/Contents/MacOS/Orca dev/host-harness.mjs   # runs the worker under Orca's real plugin host
```

Tested on Orca 1.4.240. `legacy-listener/` contains an old standalone listener that **you do not need**.

## 中文快速上手

**前提**：Orca ≥ 1.4.240；在 设置 → Plugins 打开 **Plugin system**（实验功能）；命令面板快捷键是 **Cmd+J**；webhook 地址必须能从运行 Orca 的这台 Mac 访问到。

1. **安装**：设置 → Plugins → **Install plugin** → **Git URL**，填 `https://github.com/xinnyu/orca-notify.git#v1.3.0`，点 **Install**，然后点 **Enable plugin**。
2. **添加 webhook**（二选一）：
   - 手写配置：创建 `~/.orca-notify/config.json`，内容为 `{ "url": "https://..." }`。需要 Bearer key 的话，把 key 写进 `~/.orca-notify/keys/default.key`。
   - 用脚本：先运行上面 Quickstart 里的 `curl` 命令装好 `agent-notify`，再运行 `agent-notify add-target mybot <url>`，按提示粘贴 key。**第一个添加的目标就是默认目标**；之后添加的目标加 `--default` 才会改成默认。Slack/Discord 加 `--format slack|discord --no-key`。
3. **测试**：Cmd+J → **Orca Notify: Send test event to all targets**，桌面通知会显示每个目标成功还是失败及原因。

- **Grok Bot / Cursor 自动化**：`agent-notify add-target bot <自动化 webhook URL> --default`，按提示粘贴 secret。
- **触发规则**：一个任务只通知一次。`done`/`waiting` 要在该 pane 出现过 `working` 之后才触发；`blocked` 立即通知。
- **路由**：`rules` 支持 `repoId`（即 `worktreeId` 里 `::` 前面的部分）、`pathPrefix`、`worktreeId`、`paneKey`；用 **Show last agent event** 查看 ID。
- **登记要通知的 pane（watch，v1.3.0）**：配合 `"watch": "listed"`，用 `agent-notify watch <paneKey> [--label L] [--target T] [--ttl 24h] [--once]` 登记（也支持 `--worktree/--path/--repo`），用 `unwatch` 取消，用 `list` 查看每条登记的时长和剩余有效期，用 `prune` 立即清理过期的登记。
  - **不丢登记**：每条登记是 `~/.orca-notify/watch/` 里的一个独立文件，先写临时文件再 rename 进去，不会读-改-写 `config.json`，所以多个 bot 同时登记也不会互相覆盖。文件名由 key 决定，重复登记同一个 pane 只会覆盖原来那条。插件每次收到事件都重新读取这个目录，不用重载。
  - **不留僵尸文件**：
    - 每条登记都有 TTL，默认 24 小时，可以用 `config.json` 的 `watchTtlHours` 或者 `--ttl` 修改。pane 每报一次 `working` 就自动续期，所以长任务不会过期。
    - Orca 删除 worktree（`worktree.removed` 事件）时，插件会删掉这个 worktree 相关的登记。Orca 插件 API 没有“pane/标签页关闭”事件，单独关掉的 pane 靠 TTL 清理。
    - 加 `--once` 的登记在第一次 done 通知后自动删除（默认不开）。
    - 插件在启动时、每次事件时、运行期间每 10 分钟各清理一次，残留超过 1 分钟的临时文件也会删掉。
  - **迁移**：`config.json` 里的旧 paneKey 规则照样生效。等 v1.3.0 插件运行起来以后，可以用 `agent-notify migrate-rules` 把它们挪进 watch 目录。
- **排错**：
  - 安装失败：检查 URL 是否带 `#tag`，Plugin system 是否已打开。
  - 收不到通知：在插件卡片 **… → View logs** 里查看原因。
  - 401/403：用同名重新运行一次 `add-target`。
- **安全**：Slack/Discord 的 webhook URL 本身就是密钥，以明文存在 `config.json`（权限 600）里，请妥善保管。
- **卸载**：在 设置 → Plugins 里删除插件（会连同加密库里的 key 一起删除），再运行 `rm -rf ~/.orca-notify`。

## License

MIT
