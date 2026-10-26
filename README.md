# orca-notify

**An Orca plugin that POSTs a JSON webhook when a coding agent finishes, gets blocked, or waits for your input.**

Use it to wake a bot or automation (for example a Grok Bot or Cursor automation webhook), ping your phone (ntfy, Pushover, a Slack incoming webhook), or call your own server. Any URL that accepts a JSON `POST` works.

- Subscribes to Orca's official plugin event `agent.status.changed`. It needs no pairing and no background daemon, and it does not depend on Orca's internal modules.
- Fires on configurable states (default `done`, `blocked`, `waiting`), once per state change per pane.
- Supports multiple targets with a default target and routing rules per `worktreeId` or `paneKey`, plus mute rules.
- Stores webhook keys in Orca's encrypted per-plugin secret vault and sends them as `Authorization: Bearer <key>`.
- Retries 5xx, 429 and network errors twice with backoff.

> Tested against Orca **1.4.240**. The manifest and marketplace file were validated with Orca's own schema, and the worker ran under Orca's real `plugin-host-entry.js`. Orca's plugin API is marked *experimental*, so it may change.
> The older standalone listener (launchd plus the paired-device protocol) lives in [`legacy-listener/`](legacy-listener/) and at tag `v0-listener`.

## Install

1. **Enable plugins:** Orca → Settings → **Plugins** → turn on **Plugin system**.
2. **Install:** in the same section, click **Install**, then use one of these:
   - **Git URL** tab: `https://github.com/xinnyu/orca-notify.git#v1.0.0` (a `#ref` is required).
   - **Local folder** tab: the path to a clone of this repo (the folder that contains `orca-plugin.json`).
   - Plugin authors can instead add the folder under **Development → Add path**.
3. **Approve:** Orca shows **Review permissions**. orca-notify asks for:
   - *Get notified when … agent status changes* (`events:subscribe`)
   - *Store and read secrets in the plugin's own encrypted vault* (`secrets`)
   - *Store data in the plugin's own storage folder* (`storage`)
   - *Show desktop notifications labeled with the plugin name* (`notifications:show`)

   Click **Enable plugin**. It runs as a *Background worker* (its own process on this computer).
4. **Configure** (next section), then run **Orca Notify: Reload config and import keys** from the command palette.

To remove it, open Settings → Plugins, then disable or uninstall **Orca Notify**. Delete `~/.orca-notify/` if you no longer need the config.

## Configure

The config lives at `~/.orca-notify/config.json`. See [`examples/config.example.json`](examples/config.example.json):

```json
{
  "states": ["done", "blocked", "waiting"],
  "watch": "all",
  "defaultTarget": "bot",
  "targets": {
    "bot":   { "url": "https://example.com/automations/webhook/<id>" },
    "phone": { "url": "https://ntfy.example.com/orca", "noKey": true }
  },
  "rules": [
    { "worktreeId": "<worktreeId>", "target": "phone", "label": "side project" },
    { "paneKey": "<tabId>:<leafId>", "target": "bot", "label": "backend refactor" },
    { "worktreeId": "<noisy worktreeId>", "mute": true }
  ],
  "retries": 2,
  "timeoutMs": 10000
}
```

| Field | Meaning |
|---|---|
| `states` | Agent states that trigger a webhook |
| `watch` | `all`: every pane goes to the matching rule or `defaultTarget`. `listed`: only panes or worktrees that match a rule |
| `targets.<name>.url` | Webhook URL |
| `targets.<name>.noKey` | `true` sends no `Authorization` header |
| `rules[]` | A `paneKey` match wins over a `worktreeId` match. Optional `target`, `label`, `mute` |

### Webhook keys (stored encrypted)

```bash
mkdir -p ~/.orca-notify/keys && chmod 700 ~/.orca-notify/keys
pbpaste > ~/.orca-notify/keys/bot.key      # file name = target name
```

Then run **Orca Notify: Reload config and import keys**. The plugin moves each `<target>.key` into Orca's encrypted plugin vault (Electron `safeStorage`) and **deletes the plaintext file**. To rotate a key, drop a new file and run Reload again.

### Finding IDs for rules

Let an agent change state, then run **Orca Notify: Show last agent event**. A notification shows the event's `worktreeId` and `paneKey`.

### Commands

| Command | What it does |
|---|---|
| Orca Notify: Reload config and import keys | Re-read `config.json`, import `keys/*.key` |
| Orca Notify: Send test event | POST a sample event to `defaultTarget` and show the HTTP result |
| Orca Notify: Show last agent event | Show the last event's IDs (for writing rules) |

Plugin logs are under Settings → Plugins → Orca Notify → **Logs**.

## Payload

`POST <url>` · `Content-Type: application/json` · `Authorization: Bearer <key>` (unless `noKey`)

```json
{
  "time": "2026-01-01T12:00:00.000Z",
  "label": "backend refactor",
  "watchKey": "<tabId>:<leafId>",
  "agentState": "done",
  "title": "Agent done: backend refactor",
  "body": "outcome: failure",
  "paneKey": "<tabId>:<leafId>",
  "worktreeId": "<worktreeId>",
  "seq": 42,
  "source": "orca-plugin",
  "mainAgent": { "state": "done", "outcome": "failure", "stateStartedAt": 1767268800000 }
}
```

These are the same field names as the legacy listener. The differences:
- `title` is generated because the plugin event carries no title or body.
- `body` is the agent outcome when Orca provides one, otherwise `null`.
- `seq` is a per-plugin counter.
- `label` is the rule label, falling back to the worktree ID.

Any 2xx response counts as delivered.

## How it works / limits

- Orca starts the worker on demand when an `agent.status.changed` event arrives, and stops it after about 5 idle minutes. Dedupe state (the last state per pane) and the counter live in plugin storage, so they survive restarts.
- Orca's plugin API does not expose the focused pane, so there is no "watch this pane" button. Use `watch: "all"` plus rules, and use *Show last agent event* to find IDs.
- Events from restored-but-unconfirmed sessions are filtered out by Orca and never reach the plugin.

## Development

```bash
node --test test/                                   # unit tests (routing, dedupe, retry)
ELECTRON_RUN_AS_NODE=1 /Applications/Orca.app/Contents/MacOS/Orca test/host-harness.mjs
# ^ forks Orca's real plugin-host-entry.js, feeds events, checks deliveries to a local receiver
```

## Security notes

- Keys are stored in Orca's encrypted plugin vault. Plaintext key files are deleted after import.
- Payloads contain worktree and pane IDs and agent state, but no prompts or code. Only send them to endpoints you trust, over HTTPS.
- The worker runs as a normal process on your computer, as Orca's consent dialog says. Review the code (`plugin/`) before enabling it.

## 中文说明

orca-notify 是一个 **Orca 插件**：agent 完成（done）、卡住（blocked）或等待输入（waiting）时，向你配置的 webhook POST 一条 JSON。可用来唤醒 Grok Bot / Cursor 自动化，或推送到手机、Slack 等。

**安装**
1. Orca → 设置 → **Plugins**，打开 **Plugin system**。
2. 点 **Install**，二选一：**Git URL** 填 `https://github.com/xinnyu/orca-notify.git#v1.0.0`（必须带 `#ref`）；**Local folder** 填本仓库所在文件夹路径。
3. 弹出 **Review permissions** 后，核对四项权限（事件订阅、加密密钥库、插件存储、桌面通知），点 **Enable plugin**。
4. 写好 `~/.orca-notify/config.json`（参考 `examples/config.example.json`）。把 key 放进 `~/.orca-notify/keys/<目标名>.key`，然后在命令面板运行 **Orca Notify: Reload config and import keys**。key 会导入 Orca 的加密库，明文文件随即删除。

**路由**：默认目标 `defaultTarget`；`rules` 可以按 `paneKey`（优先）或 `worktreeId` 指定目标、标签，或静音（mute）。`watch: "listed"` 表示只通知规则里列出的 pane 或 worktree。运行 **Show last agent event** 可以查看最近一次事件的 ID，方便写规则。

**说明**：同一 pane 状态不变时不会重复通知；5xx、429 和网络错误会重试两次。Orca 的插件 API 仍是实验性的，已在 1.4.240 上测试。旧版独立监听器在 `legacy-listener/` 目录和 tag `v0-listener`。

## License

MIT
