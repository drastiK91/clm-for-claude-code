// The services' pure parts: paths, scripts, command lines and parsing. Everything that reaches the
// host through $ lives in register.tsx, since $ is never passed across an import.

import type { ClmServiceProcess } from '../types'

/** Windows (PowerShell, cmd.exe) or anything with a POSIX shell (macOS, Linux). */
export type Platform = 'windows' | 'posix'

/** The machine the services run on: its platform and the person's home folder. */
export type Host = { platform: Platform; home: string }

/** Why encoder options cannot go on the start line. */
export type ArgsProblem = { kind: 'chars' } | { kind: 'reserved'; flags: string[] }

/** What stops a restart, told by kind so register.tsx says it in the person's language. */
export type Problem =
  | { kind: 'remote'; url: string }
  | { kind: 'no-llama' }
  | { kind: 'no-model'; model: string; dir: string }
  | { kind: 'no-serve' }
  | { kind: 'unsafe-path'; path: string }
  | { kind: 'bad-args'; reason: ArgsProblem }

/** Where the two services come from and where they listen, resolved for this machine. */
export type ServicePlan = {
  platform: Platform
  isLocal: boolean
  encoderBin: string | null
  encoderModel: string
  clmServeBin: string | null
  encoderPort: number
  /** The person's own llama-server options, appended after the mod's (encoderArgs). */
  encoderArgs: string
  clmPort: number
  logDir: string
  /** What stops a restart; empty when it can go ahead. */
  problems: Problem[]
}

// What the mod may stop on its own ports: llama-server, the clm-serve launcher, and a Python
// process whose command line names clm (clm-serve's interpreter). Anything else is left alone.
export const OWN_PROCESSES = ['llama-server', 'clm-serve']

export const MODEL_REPO = 'Qwen/Qwen3-8B-GGUF'
export const MODEL_FILE = 'Qwen3-8B-Q4_K_M.gguf'

// llama-server options the person may tune (parallel slots, flash attention, a q8_0 KV cache),
// added after the mod's own on the start line.
export const DEFAULT_ENCODER_ARGS = '-np 2 -fa on -ctk q8_0 -ctv q8_0'

// The options the mod sets itself: given again they would move the model, the port or the host
// (0.0.0.0 would serve the encoder to the network), or change what the embedding is.
const RESERVED_ENCODER_FLAGS = new Set(['-m', '--model', '--host', '--port', '--alias', '-a', '--embedding', '--embeddings', '--pooling', '-hf', '--hf-repo', '-mu', '--model-url'])

// Options are flags, numbers, names and plain paths: nothing cmd.exe or sh would read as an operator.
const ARGS_CHARS = /^[\w .:=/\\,+-]*$/

/** Why encoder options cannot go on the start line; null when they can. */
export function encoderArgsProblem(args: string): ArgsProblem | null {
  if (!ARGS_CHARS.test(args)) return { kind: 'chars' }

  const reserved = args.split(/\s+/).filter(word => RESERVED_ENCODER_FLAGS.has(word.split('=')[0]?.toLowerCase() ?? ''))

  return reserved.length > 0 ? { kind: 'reserved', flags: reserved } : null
}

/** Whether a path cannot be quoted on the start line: cmd.exe's metacharacters, or sh's single quote. */
export function isUnsafePath(platform: Platform, path: string): boolean {
  return platform === 'windows' ? /["%&|<>^\r\n]/.test(path) : /['\r\n]/.test(path)
}

export function join(host: Pick<Host, 'platform'>, ...parts: string[]): string {
  const sep = host.platform === 'windows' ? '\\' : '/'

  return parts.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, ''))).join(sep)
}

export function exeName(platform: Platform, name: string): string {
  return platform === 'windows' ? `${name}.exe` : name
}

export function portOf(url: string): { isLocal: boolean; port: number } {
  try {
    const u = new URL(url)
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))

    return { isLocal: ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname), port }
  } catch {
    return { isLocal: false, port: 0 }
  }
}

/** LM Studio's two homes: ~/.lmstudio (0.3 and later) and ~/.cache/lm-studio (earlier). */
function lmStudioDirs(host: Host): string[] {
  return [join(host, host.home, '.lmstudio'), join(host, host.home, '.cache', 'lm-studio')]
}

export function backendsDirs(host: Host): string[] {
  return lmStudioDirs(host).map(dir => join(host, dir, 'extensions', 'backends'))
}

/** LM Studio's llama.cpp backends, best first: CUDA 12, other CUDA, Metal or Vulkan, CPU; newest first within. */
export function orderBackends(names: string[]): string[] {
  const version = (name: string) => (/(\d+)\.(\d+)\.(\d+)$/.exec(name) ?? []).slice(1).map(Number)
  const newer = (a: string, b: string) => {
    const [x, y] = [version(a), version(b)]

    for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0)

    return 0
  }
  const rank = (name: string) => (name.includes('cuda12') ? 0 : name.includes('cuda') ? 1 : /metal|vulkan/.test(name) ? 2 : 3)

  return names.filter(name => name.startsWith('llama.cpp-')).sort((a, b) => rank(a) - rank(b) || newer(a, b))
}

/** The mod's own folders, under ~/.cache/clm: the encoder model when LM Studio has none, and the services' logs. */
export function modelsDir(host: Host): string {
  return join(host, host.home, '.cache', 'clm', 'models')
}

export function logDir(host: Host): string {
  return join(host, host.home, '.cache', 'clm', 'logs')
}

/** Where Qwen3-8B Q4_K_M may already be, LM Studio's models folders first; the last is where the help downloads it. */
export function encoderModelCandidates(host: Host): string[] {
  return [
    ...lmStudioDirs(host).map(dir => join(host, dir, 'models', 'Qwen', 'Qwen3-8B-GGUF', MODEL_FILE)),
    join(host, modelsDir(host), MODEL_FILE),
  ]
}

/** Where pipx puts clm-serve when it is not on PATH. */
export function clmServeCandidates(host: Host): string[] {
  return [join(host, host.home, '.local', 'bin', exeName(host.platform, 'clm-serve'))]
}

/** The argv that prints where a program is on PATH, one path per line; the name is the mod's own literal. */
export function whichArgv(platform: Platform, name: 'llama-server' | 'clm-serve'): string[] {
  return platform === 'windows' ? ['where.exe', name] : ['sh', '-c', `command -v ${name}`]
}

export function downloadCommand(host: Host): string {
  return `hf download ${MODEL_REPO} ${MODEL_FILE} --local-dir "${modelsDir(host)}"`
}

// Values reach the scripts as environment variables, never spliced into their text.
const WINDOWS_LISTENERS = `
$ErrorActionPreference = 'SilentlyContinue'
foreach ($p in ($env:CLM_PORTS -split ',')) {
  $c = Get-NetTCPConnection -LocalPort ([int]$p) -State Listen | Select-Object -First 1
  if ($c) { $pr = Get-Process -Id $c.OwningProcess; "$p|$($c.OwningProcess)|$($pr.ProcessName)" } else { "$p|0|" }
}`

const WINDOWS_STOP = `
$ErrorActionPreference = 'SilentlyContinue'
$own = $env:CLM_OWN -split ','
foreach ($p in ($env:CLM_PORTS -split ',')) {
  $c = Get-NetTCPConnection -LocalPort ([int]$p) -State Listen | Select-Object -First 1
  if (-not $c) { "$p|free|0|"; continue }
  $pr = Get-Process -Id $c.OwningProcess
  $info = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
  $isOurs = ($own -contains $pr.ProcessName) -or ($pr.ProcessName -like 'python*' -and $info.CommandLine -match 'clm')
  if ($isOurs) {
    Stop-Process -Id $c.OwningProcess -Force
    # clm-serve's venv launcher waits on its Python child: stop it too, and nothing else.
    $pp = Get-Process -Id $info.ParentProcessId
    if ($pp -and $pp.ProcessName -eq 'clm-serve') { Stop-Process -Id $pp.Id -Force }
    "$p|stopped|$($c.OwningProcess)|$($pr.ProcessName)"
  } else { "$p|foreign|$($c.OwningProcess)|$($pr.ProcessName)" }
}`

// Win32_Process.Create starts the child outside Claude's process tree, so it outlives the session.
const WINDOWS_START = `
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $env:CLM_LOGDIR | Out-Null
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:CLM_CMDLINE; CurrentDirectory = $env:CLM_LOGDIR; ProcessStartupInformation = $startup }
"$($r.ReturnValue)|$($r.ProcessId)"`

// lsof answers the same on macOS and Linux; ps's comm is the program's name (clm-serve's script on
// Linux, its interpreter on macOS, which the command line then tells apart).
const POSIX_LISTENERS = `
for p in $(printf '%s' "$CLM_PORTS" | tr ',' ' '); do
  pid=$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null | head -n 1)
  if [ -n "$pid" ]; then echo "$p|$pid|$(ps -p "$pid" -o comm= 2>/dev/null | sed 's#.*/##')"; else echo "$p|0|"; fi
done`

// A stopped process lets go of its port only once it has exited: wait for it (5 s at most, then
// SIGKILL), so the start that follows can bind.
const POSIX_STOP = `
own=",$CLM_OWN,"
for p in $(printf '%s' "$CLM_PORTS" | tr ',' ' '); do
  pid=$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null | head -n 1)
  if [ -z "$pid" ]; then echo "$p|free|0|"; continue; fi
  name=$(ps -p "$pid" -o comm= 2>/dev/null | sed 's#.*/##')
  args=$(ps -p "$pid" -o args= 2>/dev/null)
  ours=0
  case "$own" in *",$name,"*) ours=1 ;; esac
  case "$name" in python*) case "$args" in *clm*) ours=1 ;; esac ;; esac
  if [ "$ours" = 1 ]; then
    kill "$pid" 2>/dev/null
    i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
    kill -9 "$pid" 2>/dev/null
    echo "$p|stopped|$pid|$name"
  else
    echo "$p|foreign|$pid|$name"
  fi
done`

// setsid (Linux) puts the child in a session of its own and nohup ignores the hangup, so it
// outlives the session; stdin, stdout and stderr are let go, so the run returns at once.
const POSIX_START = `
mkdir -p "$CLM_LOGDIR" && cd "$CLM_LOGDIR" || { echo "1|0"; exit 0; }
if command -v setsid >/dev/null 2>&1; then
  setsid nohup sh -c "$CLM_CMDLINE" </dev/null >/dev/null 2>&1 &
else
  nohup sh -c "$CLM_CMDLINE" </dev/null >/dev/null 2>&1 &
fi
echo "0|$!"`

export type ScriptName = 'listeners' | 'stop' | 'start'

const SCRIPTS: Record<Platform, Record<ScriptName, string>> = {
  windows: { listeners: WINDOWS_LISTENERS, stop: WINDOWS_STOP, start: WINDOWS_START },
  posix: { listeners: POSIX_LISTENERS, stop: POSIX_STOP, start: POSIX_START },
}

export function scriptArgv(platform: Platform, script: ScriptName): string[] {
  const text = SCRIPTS[platform][script]

  return platform === 'windows'
    ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', text]
    : ['sh', '-c', text]
}

export function parseListeners(stdout: string): Map<number, ClmServiceProcess | null> {
  const found = new Map<number, ClmServiceProcess | null>()

  for (const line of stdout.split(/\r?\n/)) {
    const [port, pid, name] = line.trim().split('|')

    if (port === undefined || pid === undefined || !/^\d+$/.test(port)) continue
    found.set(Number(port), Number(pid) > 0 ? { pid: Number(pid), name: name ?? '' } : null)
  }

  return found
}

/** One port as the stop script left it: freed by the mod, free already, or held by a process the mod leaves alone. */
export type StopEntry = { port: number; what: 'stopped' | 'free' | 'foreign'; pid: number; name: string }

export function parseStop(stdout: string): StopEntry[] {
  const entries: StopEntry[] = []

  for (const line of stdout.split(/\r?\n/)) {
    const [port, what, pid, name] = line.trim().split('|')

    if (port === undefined || !/^\d+$/.test(port)) continue
    if (what === 'stopped' || what === 'free' || what === 'foreign') {
      entries.push({ port: Number(port), what, pid: Number(pid ?? 0), name: name ?? '' })
    }
  }

  return entries
}

/** `0|<pid>` from the start script: the pid; otherwise the code and what the script said. */
export function parseStart(exitCode: number, stdout: string, stderr: string): { ok: true; pid: number } | { ok: false; code: string; stderr: string } {
  const [code, pid] = stdout.trim().split(/\r?\n/).pop()?.split('|') ?? []

  if (exitCode !== 0 || code !== '0') return { ok: false, code: code ?? String(exitCode), stderr: stderr.trim().slice(0, 200) }

  return { ok: true, pid: Number(pid) }
}

/**
 * The two command lines, each service's output in its own log: wrapped in cmd.exe on Windows, and
 * on POSIX a line `sh -c` runs, exec'd so the pid the start script reports is the service's own.
 */
export function commandLines(plan: ServicePlan): { encoder: string; serve: string } {
  const quoted = (path: string) => (plan.platform === 'windows' ? `"${path}"` : `'${path}'`)
  const log = (name: string) => quoted(join(plan, plan.logDir, `${name}.log`))
  const encoderArgs = [
    '-m', quoted(plan.encoderModel),
    '--embeddings', '--pooling', 'last', '-ngl', '99',
    '-c', '2048', '-b', '2048', '-ub', '2048',
    '--host', '127.0.0.1', '--port', String(plan.encoderPort), '--alias', 'qwen3-8b',
    ...(plan.encoderArgs.trim() === '' ? [] : [plan.encoderArgs.trim()]),
  ].join(' ')
  const serveArgs = ['--host', '127.0.0.1', '--port', String(plan.clmPort), '--emb-url', `http://127.0.0.1:${plan.encoderPort}/v1/embeddings`].join(' ')
  const encoderBin = quoted(plan.encoderBin ?? '')
  const serveBin = quoted(plan.clmServeBin ?? '')

  if (plan.platform === 'posix') {
    return {
      encoder: `exec ${encoderBin} ${encoderArgs} > ${log('encoder')} 2>&1`,
      serve: `export PYTHONIOENCODING=utf-8; exec ${serveBin} ${serveArgs} > ${log('clm-serve')} 2>&1`,
    }
  }

  return {
    encoder: `cmd.exe /d /s /c "${encoderBin} ${encoderArgs} > ${log('encoder')} 2>&1"`,
    serve: `cmd.exe /d /s /c "set PYTHONIOENCODING=utf-8&& ${serveBin} ${serveArgs} > ${log('clm-serve')} 2>&1"`,
  }
}
