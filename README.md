# Orca Notify (`xinnyu.agent-notify`)

**An Orca plugin that sends a webhook when a coding agent finishes, gets blocked, or waits for your input. You get exactly one notification per finished task.**

It works with any URL that accepts a JSON `POST`: Grok Bot or Cursor automation webhooks, Slack or Discord incoming webhooks, ntfy, or your own server.

## Quickstart (3 steps)

**1. Install.** In Orca, open Settings → **Plugins**, turn on **Plugin system**, then click **Install plugin** → **Git URL** and enter:

```
https://github.com/xinnyu/orca-notify.git#v1.1.0
```

In **Review permissions**, click **Enable plugin**.

**2. Add a webhook.** Clone this repo, or download [`bin/agent-notify`](bin/agent-notify) (a plain bash script with no dependencies). Then run:

```bash
bin/agent-notify add-target mybot https://example.com/hooks/abc        # prompts for a bearer key (Enter = none)
# Slack / Discord incoming webhooks need no key:
bin/agent-notify add-target slack https://hooks.slack.com/services/... --format slack --no-key
```

**3. Test.** In Orca, press **Cmd+J** and run **Orca Notify: Send test event to all targets**. A desktop notification shows `OK` or the HTTP error for each target.

That's all. The plugin reads its config on every agent event, so no reload is needed. The first target you add becomes the default, and every agent in every workspace reports to it.

<details><summary>No script? Edit the config by hand</summary>

The plugin creates `~/.orca-notify/config.json` the first time it runs. The smallest working config is:

```json
{ "url": "https://example.com/hooks/abc" }
```

If the endpoint needs a bearer token, save it to `~/.orca-notify/keys/default.key`. The file name is the target name, and `default` is the name used when you set `url` directly.
</details>

## What gets sent

`POST <url>` with `Content-Type: application/json`, plus `Authorization: Bearer <key>` if the target has a key.

```json
{
  "time": "2026-01-01T12:00:00.000Z",
  "label": "polytrader/main",
  "watchKey": null,
  "agentState": "done",
  "title": "Agent done: polytrader/main",
  "body": null,
  "paneKey": "<tabId>:<leafId>",
  "worktreeId": "<repoId>::/path/to/worktree",
  "seq": 42,
  "source": "orca-plugin",
  "mainAgent": { "state": "done", "stateStartedAt": 1767268800000 }
}
```

- `"format": "slack"` sends `{ "text": "Agent done: …" }` and `"format": "discord"` sends `{ "content": "…" }`.
- **When it fires:**
  - `done` or `waiting` fire only after the pane was seen `working`. That gives one notification per task and skips the idle "done" a new session reports.
  - `blocked` fires immediately, once each time the pane becomes blocked.
- Any 2xx response counts as delivered. 5xx, 429 and network errors are retried twice. If delivery still fails, Orca shows a desktop notification.

## Routing (optional)

```json
{
  "defaultTarget": "mybot",
  "targets": {
    "mybot":  { "url": "https://example.com/hooks/abc" },
    "slack":  { "url": "https://hooks.slack.com/services/...", "format": "slack", "noKey": true }
  },
  "rules": [
    { "repoId": "<repo id from `orca repo list`>", "target": "slack", "label": "side project" },
    { "pathPrefix": "/Users/me/Project/app", "target": "mybot" },
    { "worktreeId": "<repoId>::/path/to/worktree", "mute": true },
    { "paneKey": "<tabId>:<leafId>", "target": "mybot", "label": "long refactor" }
  ],
  "states": ["done", "blocked", "waiting"],
  "watch": "all"
}
```

- **Which rule applies:** the most specific match wins, in this order: `paneKey`, `worktreeId`, `pathPrefix`, `repoId`. If nothing matches, the event goes to `defaultTarget`.
- **Matching a repo:** a worktree id is `<repoId>::<path>`, so a `repoId` rule covers every worktree of that repo. `pathPrefix` matches by folder.
- **`watch: "listed"`** only notifies for panes, worktrees or repos that match a rule.
- **Finding ids:** **Orca Notify: Show last agent event** shows the latest event's `worktreeId` and `paneKey`.

## Example: wake a Grok Bot / Cursor automation

Create a webhook-triggered routine or automation and copy its URL and secret. Then run:

```bash
bin/agent-notify add-target bot https://<automation-webhook-url> --default   # paste the secret when prompted
```

The bot receives the JSON payload above. Have it inspect the workspace (`worktreeId`) and take the next step.

## Commands (Cmd+J)

| Command | What it does |
|---|---|
| Orca Notify: Show status | Reloads the config, imports keys, and shows the targets, the default target and the rule count |
| Orca Notify: Send test event to all targets | Sends a sample event to every target and reports OK or the error for each |
| Orca Notify: Show last agent event | Shows the ids you need for writing rules |

`bin/agent-notify status` shows the config, the queued targets and the keys still waiting to be imported. It never prints keys.

## How keys are stored

Key files dropped into `~/.orca-notify/keys/` are imported into Orca's encrypted per-plugin vault (Electron `safeStorage`) the next time the plugin runs, and the plaintext file is deleted. To rotate a key, add the target again or drop a new key file.

## Troubleshooting

- **"Plugin installation failed. Check the source and try again."**
  - Make sure the URL ends in a tag, for example `#v1.1.0`.
  - Plugin authors: Orca reserves plugin ids that start with `orca-`, and the publisher `stablyai`, for official plugins. Installs of such ids fail with only this generic message. That is why this plugin's id is `agent-notify`.
- **Nothing arrives:**
  - Run **Send test event**. If the test works but real events don't, check that the plugin shows **Enabled** in Settings → Plugins.
  - Check the plugin's **Logs** in Settings → Plugins. Every skipped event is logged with the reason.
- **"no webhook configured" notification:** add a target (step 2).
- **"config.json is invalid":** fix the JSON in `~/.orca-notify/config.json`. The notification includes the parse error.
- **Permissions:** Orca asks once for *agent status events*, *encrypted secrets*, *plugin storage* and *desktop notifications*. If the plugin's permissions change in a new version, Orca asks again.
- **Upgrading:** run **Install plugin** again with the new `#tag`.

## Development

```bash
node --test test/                                                     # unit tests
ELECTRON_RUN_AS_NODE=1 /Applications/Orca.app/Contents/MacOS/Orca test/host-harness.mjs   # runs the worker under Orca's real plugin host
```

Tested on Orca 1.4.240. Orca's plugin API is marked experimental. The older standalone listener is in [`legacy-listener/`](legacy-listener/) (tag `v0-listener`).

## 中文快速上手

1. **安装**：Orca → 设置 → **Plugins**，打开 **Plugin system**，点 **Install plugin** → **Git URL**，填 `https://github.com/xinnyu/orca-notify.git#v1.1.0`，在权限确认页点 **Enable plugin**。
2. **添加 webhook**：`bin/agent-notify add-target mybot <webhook地址>`，按提示粘贴 Bearer key（没有就直接回车）。Slack/Discord 加 `--format slack|discord --no-key`。第一个添加的目标就是默认目标。
3. **测试**：在 Orca 里按 Cmd+J，运行 **Orca Notify: Send test event to all targets**，桌面通知会显示每个目标成功还是失败。

- **触发规则**：一个任务只通知一次。`done`/`waiting` 要在该 pane 出现过 `working` 之后才会触发；`blocked` 立即通知。
- **路由**：可在 `~/.orca-notify/config.json` 的 `rules` 里按 `repoId`、`pathPrefix`、`worktreeId` 或 `paneKey` 把通知分到不同目标，也可以静音（`mute`）。
- **key 保管**：key 会导入 Orca 的加密库，明文文件随即删除。

## License

MIT
