# Changelog

## 0.2.0 — 2026-11-03

First public release.

### Added

- **English and Italian.** The mod follows Claude Code's `language` setting, then the system locale (the registry on Windows);
  `/clm lang auto|en|it` and the menu switch it. Settings from the Italian-only 0.1 stay in Italian.
- **macOS and Linux service management.** `restart`, `stop` and `services` run through `sh`, `lsof` and `nohup`/`setsid`, beside
  the existing PowerShell path on Windows.
- **Discovery instead of hardcoded paths.** `llama-server` from LM Studio's backends (`~/.lmstudio` and `~/.cache/lm-studio`) or
  `PATH`; `clm-serve` from `PATH` or pipx; the encoder model from LM Studio or `~/.cache/clm/models`. New `/clm llama <path>`.
- **`CLM_API_KEY`** sent as a bearer token, and **`CLM_BASE_URL`** as the default URL, like CLM's own client.
- **CLM heads.** `/clm model <name>|default` and the menu's `h` pick the head `clm-serve` answers with.
- **Thresholds in percent.** `/clm guard 60`, `/clm check 85`; the menu shows them.
- **`/clm help`, `/clm clear`**, and Italian aliases (`stato`, `aiuto`, `registro`, `pulisci`, `riavvia`, `ferma`, `servizi`, `lingua`, `modello`).

### Changed

- **The log pane, redrawn.** The state in a word (Ready, Offline, Off), with the way out beside it when CLM is not ready:
  **Turn CLM on**, or **Restart services** and what the restart said. Under it the head and the endpoint, then a summary in
  small type with tabular figures (calls, p50, p95, errors, flags), a latency sparkline on the terminal and a one-color SVG chart
  elsewhere (failed calls as red ticks, the scale on the left), and a filter per source the log holds. Each call is two lines:
  time, source, subject and latency; then its headline (risk, failure, best candidate) as a meter in the color of its threshold,
  with CLM's pick beside it. **▸** opens the full distribution, with the server's time and tokens. An empty log offers a quick test.
- **Meters** are rounded SVG pills where the surface draws SVG (desktop), and blocks on a thin track on the terminal.
- Spacing follows the surface: room between calls on desktop, none spent on the terminal.
- **Terms are translated where they are drawn** (safe → sicuro, failure → fallimento), so the log follows a change of language.
- **Network errors read as such**: "clm-serve unreachable (connection refused)" instead of the fetch's own message.
- **The band above the prompt** shows the source, the subject, the headline as a colored bar and CLM's pick, or the flag when the
  check sent Claude a note.
- **The menu** is grouped into services and features, with each switch's state and threshold and the head and language pickers.
- **`/clm status`** is a markdown card.
- Guard and check calls are logged as the command (`$ rm -rf build`) instead of the prompt CLM was sent.
- Colors follow the person's theme (theme keys instead of raw color names).
- The check also recognizes `npm ERR!` and nonzero `exit code`/`exit status` lines.
- Encoder options accept only letters, digits, spaces and `. : = / \ , + -`, on every platform.

### Fixed

- Log entries kept their ids across a hot reload, which restarted the sequence: a flag could land on an older call.
- A rejected `CLM_API_KEY` now says so (HTTP 401) instead of a raw error body; FastAPI's `detail` is shown for other errors.

## 0.1.0 — 2026-10-07

Private, Italian-only version: rank/ask tools, guard, check, band, log, footer tag, context menu, Windows service management.
