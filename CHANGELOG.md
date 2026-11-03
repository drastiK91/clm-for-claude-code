# Changelog

## 0.2.2 — 2026-11-03

### Fixed

- **▸ opens on every command the pane cuts.** 0.2.1 kept the whole text only past 160 characters, but a docked pane cuts
  a row's line far sooner: a command of 60–150 characters was cut on screen and still not shown when opened. The opened
  row now shows the command whenever it is longer than the line has room for, calls logged before this version included.

## 0.2.1 — 2026-11-03

### Added

- **The whole command in the log.** A row's line still cuts a long or multi-line command; **▸** now opens it in full
  (its first 2000 characters, wrapped, in monospace) above the distribution. Calls CLM did not answer open on it too.

### Fixed

- **The check fires again.** It asked CLM a success/failure choice, whose failure probability stayed at 3–27% on real
  failures with the llama.cpp encoder: under the 80% threshold, so no note was ever sent. It now asks a yes/no question
  ("does this output show that the command failed…?"). On 14 outputs that all hold an error word, it caught 6 of 8 real
  failures at the new 70% default, with no note on the 6 successes (`Found 0 errors`, `tests/test_failures.py` passing…).
  The log still shows failure and success.
- **A check threshold saved by 0.2.0 is reset to 70% once**, since the number now means something different. Set your own
  again with `/clm check <1-99>`: it stays.
- **`rank` asks for full sentences.** One-word candidates ranked poorly ("Rome" as the capital of France); written as
  sentences, the same cases rank right. The tool's description now tells Claude so.

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
