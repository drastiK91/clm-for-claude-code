import { describe, expect, mock, test } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bar, percentile, sparkline } from './draw'
import { isItalian } from './i18n'
import { commandLines, encoderArgsProblem, orderBackends } from './services'

const SURFACES = ['terminal', 'desktop'] as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const
const VIEW = { scroll: { offset: 0, bodyRows: 20 }, view: {} } as const

const FOOTER = { component: 'SessionMode', props: { modes: [] } } as const
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, ...VIEW },
} as const
const PANE = {
  component: 'Pane',
  requestId: 'clm-log',
  props: { title: 'CLM-8B', isFocused: false, bodyColumns: 120, placement: 'dock', ...VIEW },
} as const
const MENU = {
  component: 'Pane',
  requestId: 'clm-menu',
  props: { title: 'CLM-8B', isFocused: true, bodyColumns: 100, placement: 'inline', ...VIEW },
} as const

const TAG = 'clm-tag-client'
const DOT = { type: 'Text', text: /^[●○◌]/, in: TAG } as const

type Server = {
  isUp?: boolean
  failure?: number
  decision?: 'allow' | 'ask'
  /** The first /v1/systemone call is refused for its length, as llama-server refuses it. */
  overflowOnce?: boolean
  /** /v1/systemone fails at the network level (connection refused). */
  isSystemOneDown?: boolean
  models?: string[]
  /** What $.store holds at the start, as an earlier version left it. */
  store?: Record<string, unknown>
}

type Hit = { url: string; headers: Record<string, string>; body: Record<string, unknown> }

/** A clm-serve stand-in beneath the plugin: /health, /v1/rank and /v1/systemone, each request kept. */
function fakeServer(
  on: On,
  { isUp = true, failure = 0.95, decision = 'allow', overflowOnce = false, isSystemOneDown = false, models = ['clm-latest', 'clm-raw'], store = {} }: Server = {},
) {
  const hits = { health: 0, rank: 0, systemone: 0, states: [] as string[], requests: [] as Hit[] }
  let isOverflowPending = overflowOnce

  mock.clock(on)
  mock.store(on, store)
  on('tool.check', () => ({ decision }))
  on('http.fetch', ($, e) => {
    const json = (body: unknown) => ({
      value: { status: 200, ok: true, headers: { 'x-clm-latency-ms': '12.5' }, text: JSON.stringify(body) },
    })

    if (e.url.endsWith('/health')) {
      hits.health += 1

      return json({ ok: true, embedder: isUp, models })
    }

    const body = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    hits.requests.push({ url: e.url, headers: e.init?.headers ?? {}, body })

    if (e.url.endsWith('/v1/rank')) {
      hits.rank += 1

      return json({
        ranked: [
          { rank: 1, candidate: 'The Moon', prob: 0.95 },
          { rank: 2, candidate: 'The Sun', prob: 0.05 },
        ],
      })
    }

    hits.systemone += 1

    if (isSystemOneDown) return { deny: 'connect ECONNREFUSED 127.0.0.1:8700' }

    const questions = (body.questions ?? {}) as Record<string, unknown>
    hits.states.push(String(body.state))

    if (isOverflowPending) {
      isOverflowPending = false

      return {
        value: {
          status: 502,
          ok: false,
          headers: {},
          text: JSON.stringify({
            detail: `embedder error 400: ${'x'.repeat(200)} request (4466 tokens) exceeds the available context size (2048 tokens)`,
          }),
        },
      }
    }

    if ('outcome' in questions) {
      return json({
        answers: {
          outcome: { type: 'choice', choice: 'failure', confidence: 0.9, probabilities: { success: 1 - failure, failure } },
        },
        usage: { input_tokens: 40 },
      })
    }

    return json({
      answers: {
        risk: {
          type: 'choice',
          choice: 'safe',
          confidence: 0.8,
          probabilities: { safe: 0.9, destructive: 0.06, exfiltration: 0.04 },
        },
      },
      usage: { input_tokens: 20 },
    })
  })

  return hits
}

type Host = {
  platform?: 'windows' | 'posix'
  hasModel?: boolean
  isPortTaken?: boolean
  /** What `where`/`command -v` finds on PATH, by program. */
  onPath?: Partial<Record<'llama-server' | 'clm-serve', string>>
  /** More environment variables beside the platform's own. */
  env?: Record<string, string>
}

/**
 * The host beneath the services: the environment, LM Studio's backends (Windows), the files, and
 * the scripts' runs (told apart by the variables they carry), each recorded; no process is touched.
 */
function fakeHost(on: On, { platform = 'windows', hasModel = true, isPortTaken = false, onPath = {}, env = {} }: Host = {}) {
  const runs: { script: 'listeners' | 'stop' | 'start' | 'which' | 'reg'; argv: readonly string[]; env: Record<string, string> }[] = []
  const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })

  mock.env(on, platform === 'windows' ? { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\Tester', ...env } : { HOME: '/home/tester', ...env })
  on('fs.list', ($, e) => ({
    value: platform === 'windows' && e.path.includes('.lmstudio') ? [dir('llama.cpp-win-x86_64-avx2-2.49.0'), dir('llama.cpp-win-x86_64-nvidia-cuda12-avx2-2.53.0')] : [],
  }))
  on('fs.exists', ($, e) => ({
    // The model is in LM Studio's folder (or one the test names under /usr/share); pipx's clm-serve is there on Windows only.
    // (The kit hands a POSIX path on as this machine resolves it, so it is matched by its tail.)
    value: e.path.endsWith('.gguf')
      ? e.path.replace(/\\/g, '/').includes('/usr/share/') || (hasModel && e.path.includes('lm-studio'))
      : platform === 'windows' || e.path.replace(/\\/g, '/').includes('/usr/'),
  }))
  on('process.run', ($, e) => {
    const vars = e.init?.env ?? {}
    const done = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const program = e.argv[0] ?? ''

    if (program === 'reg') {
      runs.push({ script: 'reg', argv: e.argv, env: vars })

      return done('    LocaleName    REG_SZ    en-US\r\n')
    }

    if (program === 'where.exe' || (program === 'sh' && (e.argv[2] ?? '').startsWith('command -v'))) {
      runs.push({ script: 'which', argv: e.argv, env: vars })
      const name = program === 'where.exe' ? e.argv[1] : (e.argv[2] ?? '').split(' ').pop()
      const found = onPath[name as 'llama-server' | 'clm-serve']

      return found === undefined ? done('', 1) : done(`${found}\n`)
    }

    if (vars.CLM_CMDLINE !== undefined) {
      runs.push({ script: 'start', argv: e.argv, env: vars })

      return done(`0|${4000 + runs.length}`)
    }

    if (vars.CLM_OWN !== undefined) {
      runs.push({ script: 'stop', argv: e.argv, env: vars })

      return done(isPortTaken ? '8090|foreign|77|nginx\n8700|free|0|' : '8090|stopped|11|llama-server\n8700|free|0|')
    }

    runs.push({ script: 'listeners', argv: e.argv, env: vars })

    return done('8090|4001|llama-server\n8700|4002|python')
  })

  return runs
}

const services = (runs: ReturnType<typeof fakeHost>) => runs.filter(r => r.script === 'listeners' || r.script === 'stop' || r.script === 'start')

function fakeBash(on: On, text: string) {
  // Typed loosely: the kit's per-tool typing of this matcher is deep enough to stall tsc.
  const loose = on as unknown as (event: string, matcher: object, hook: () => unknown) => void

  loose('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: text, stderr: '', interrupted: false }, text }))
}

/** Starts the session as the engine does, so what session.start reads (store, environment, locale) applies. */
async function startSession($: { session: { start: (input: never) => Promise<unknown> } }, on: On) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true } as never)
}

/** The model's own tool call, typed loosely: the kit's per-tool typing is deep enough to stall tsc. */
function callTool($: { tool: { call: (input: never) => Promise<unknown> } }, input: Record<string, unknown>) {
  return $.tool.call(input as never) as Promise<{ text?: string; result?: unknown; context?: string[] }>
}

const FAILED_TESTS = 'FAIL src/a.test.ts\n3 failed, 12 passed in 2.1s'

/** Another plugin's footer tag: a plain tree (the kit refuses a Client in an inline plugin) around what lies beneath. */
const OTHER: Plugin = {
  name: 'other',
  register(on) {
    on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
      const inner = await next(e)
      const { Box, Text } = $.ui.resolve(e)

      return (
        <Box key="other-tag" flexDirection="row">
          {inner}
          <Text>OTHER</Text>
        </Box>
      )
    })
  },
}

/** The engine's own mode labels at the bottom of the SessionMode chain (the kit draws none). */
function engineModes(on: On) {
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box key="engine-modes">
        <Text>{e.props.modes.join(' & ')}</Text>
      </Box>
    )
  })
}

describe('clm: drawing helpers', () => {
  test('bars fill to an eighth of a cell, then a thin track, and keep their width', async () => {
    expect(bar(0.5, 8)).toEqual({ filled: '████', track: '────' })
    expect(bar(1, 4).filled).toBe('████')
    expect(bar(0, 4)).toEqual({ filled: '', track: '────' })
    expect(bar(0.3, 10).filled).toBe('███')
    const part = bar(0.33, 10)

    expect(part.filled.length + part.track.length).toBe(10)
  })

  test('sparklines run low to high on a log scale; percentiles by nearest rank', async () => {
    expect(sparkline([10, 100, 1000], 3)).toBe('▁▅█')
    expect(sparkline([50, 50], 4)).toBe('▄▄')
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(20)
    expect(percentile([10, 20, 30, 40], 0.95)).toBe(40)
  })

  test('encoder options: shell operators and the flags the mod sets are refused', async () => {
    expect(encoderArgsProblem('-np 4 -fa on -ctk q8_0')).toBe(null)
    expect(encoderArgsProblem('-np 2; rm -rf ~')?.kind).toBe('chars')
    expect(encoderArgsProblem('-np $(id)')?.kind).toBe('chars')
    expect(encoderArgsProblem('--host=0.0.0.0')).toEqual({ kind: 'reserved', flags: ['--host=0.0.0.0'] })
  })

  test('backends: CUDA 12 first, then Metal or Vulkan, newest first; POSIX lines exec under single quotes', async () => {
    expect(orderBackends(['llama.cpp-mac-arm64-apple-metal-1.2.0', 'llama.cpp-win-x86_64-nvidia-cuda12-avx2-2.53.0', 'other', 'llama.cpp-win-x86_64-avx2-2.60.0'])).toEqual([
      'llama.cpp-win-x86_64-nvidia-cuda12-avx2-2.53.0',
      'llama.cpp-mac-arm64-apple-metal-1.2.0',
      'llama.cpp-win-x86_64-avx2-2.60.0',
    ])

    const lines = commandLines({
      platform: 'posix',
      isLocal: true,
      encoderBin: '/opt/homebrew/bin/llama-server',
      encoderModel: '/models/q.gguf',
      clmServeBin: '/home/t/.local/bin/clm-serve',
      encoderPort: 8090,
      encoderArgs: '-np 2',
      clmPort: 8700,
      logDir: '/home/t/.cache/clm/logs',
      problems: [],
    })

    expect(lines.encoder).toBe(
      "exec '/opt/homebrew/bin/llama-server' -m '/models/q.gguf' --embeddings --pooling last -ngl 99 -c 2048 -b 2048 -ub 2048 --host 127.0.0.1 --port 8090 --alias qwen3-8b -np 2 > '/home/t/.cache/clm/logs/encoder.log' 2>&1",
    )
    expect(lines.serve).toContain("export PYTHONIOENCODING=utf-8; exec '/home/t/.local/bin/clm-serve' --host 127.0.0.1 --port 8700")
  })

  test('Italian is told from locales and language names', async () => {
    for (const value of ['it', 'it-IT', 'it_IT.UTF-8', 'Italian', 'italiano']) expect(isItalian(value)).toBe(true)
    for (const value of ['en_US.UTF-8', 'C.UTF-8', 'item', '', undefined]) expect(isItalian(value)).toBe(false)
  })
})

describe('clm', () => {
  test('the footer tag: a left click switches, grey when off, green once ready, grey again', async ($, on) => {
    fakeServer(on)
    fakeHost(on)
    engineModes(on)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'clm', surface, ...FOOTER })

      expect(await ui.find({ type: 'Text', text: 'CLM-8B off', in: TAG })).toBeDefined()
      expect((await ui.find(DOT))?.props.dimColor).toBe(true)

      await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: TAG })

      expect(await ui.find({ type: 'Text', text: 'ready', in: TAG })).toBeDefined()
      expect((await ui.find(DOT))?.props.color).toBe('success')

      await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: TAG })

      expect(await ui.find({ type: 'Text', text: 'CLM-8B off', in: TAG })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a right click on the footer tag opens the menu', async ($, on) => {
    fakeServer(on)
    fakeHost(on)
    engineModes(on)
    const opened: string[] = []
    on('ui.open', ($, e) => {
      opened.push(e.id)

      return { value: { isPlaced: true } }
    })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'clm', surface, ...FOOTER })
      await ui.pointer({ type: 'up', x: 2, y: 0, button: 'right', in: TAG })
      await ui.unmount()
    }

    expect(opened).toEqual(['clm-menu', 'clm-menu'])
  })

  test('the dot turns red while the encoder is unreachable', async ($, on) => {
    fakeServer(on, { isUp: false })
    fakeHost(on)
    engineModes(on)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'clm', surface, ...FOOTER })
      await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: TAG })

      expect((await ui.find(DOT))?.props.color).toBe('error')
      expect(await ui.find({ type: 'Text', text: 'offline', in: TAG })).toBeDefined()
      await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: TAG })
      await ui.unmount()
    }
  })

  test('/clm tag button draws a plain Button instead, still switching on a press', async ($, on) => {
    fakeServer(on)
    fakeHost(on)
    engineModes(on)
    await $.command.run({ command: 'clm', args: 'tag button', ...RUN })

    const ui = await $.ui.mount({ plugin: 'clm', surface: 'desktop', ...FOOTER })

    expect((await ui.find({ key: 'toggle' }))?.text).toContain('off')
    await ui.press({ key: 'toggle' })
    expect((await ui.find({ key: 'toggle' }))?.text).toContain('ready')
    await ui.unmount()
  })

  test('the menu switches settings, cycles the head and shows the services', async ($, on) => {
    fakeServer(on)
    fakeHost(on)
    await $.command.run({ command: 'clm', args: 'on', ...RUN })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'clm', surface, ...MENU })

      expect((await ui.find({ key: 'm-guard' }))?.text).toContain('ON')
      expect((await ui.find({ key: 'm-guard' }))?.text).toContain('70.0%')
      await ui.press({ key: 'm-guard' })
      expect((await ui.find({ key: 'm-guard' }))?.text).toContain('OFF')
      await ui.press({ key: 'm-guard' })

      expect((await ui.find({ key: 'm-head' }))?.text).toContain('server default')
      await ui.press({ key: 'm-head' })
      expect((await ui.find({ key: 'm-head' }))?.text).toContain('clm-latest')
      await ui.press({ key: 'm-head' })
      await ui.press({ key: 'm-head' })
      expect((await ui.find({ key: 'm-head' }))?.text).toContain('server default')

      await ui.press({ key: 'm-refresh' })
      expect(await ui.find({ type: 'Text', text: 'llama-server · PID 4001' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the menu switches the language at once', async ($, on) => {
    fakeServer(on)
    fakeHost(on)

    const ui = await $.ui.mount({ plugin: 'clm', surface: 'desktop', ...MENU })

    expect((await ui.find({ key: 'm-lang' }))?.text).toContain('English')
    await ui.press({ key: 'm-lang' })
    expect((await ui.find({ key: 'm-lang' }))?.text).toContain('Italiano')
    expect((await ui.find({ key: 'm-toggle' }))?.text).toContain('Accendi CLM')
    await ui.unmount()
  })

  test('restart stops ours, then starts the encoder on Qwen3-8B and clm-serve, detached', async ($, on) => {
    fakeServer(on)
    const runs = fakeHost(on, { onPath: { 'clm-serve': 'C:\\tools\\clm\\clm-serve.exe' } })
    const said = await $.command.run({ command: 'clm', args: 'restart', ...RUN })
    const starts = runs.filter(r => r.script === 'start').map(r => r.env.CLM_CMDLINE ?? '')

    expect(said.text).toContain('encoder started')
    expect(said.text).toContain('clm-serve started')
    expect(runs.findIndex(r => r.script === 'stop')).toBeLessThan(runs.findIndex(r => r.script === 'start'))
    expect(starts).toHaveLength(2)
    expect(starts[0]).toContain('.lmstudio\\extensions\\backends\\llama.cpp-win-x86_64-nvidia-cuda12-avx2-2.53.0\\llama-server.exe')
    expect(starts[0]).toContain('lm-studio\\models\\Qwen\\Qwen3-8B-GGUF\\Qwen3-8B-Q4_K_M.gguf')
    expect(starts[0]).toContain('--pooling last')
    expect(starts[0]).toContain('--alias qwen3-8b -np 2 -fa on -ctk q8_0 -ctv q8_0 >')
    expect(starts[1]).toContain('set PYTHONIOENCODING=utf-8&& "C:\\tools\\clm\\clm-serve.exe"')
    expect(starts[1]).toContain('--emb-url http://127.0.0.1:8090/v1/embeddings')
    expect(runs.find(r => r.script === 'start')?.argv[0]).toBe('powershell.exe')
  })

  test('on macOS and Linux the services run through sh: llama-server and clm-serve from PATH, logs in ~/.cache/clm', async ($, on) => {
    fakeServer(on)
    const runs = fakeHost(on, {
      platform: 'posix',
      hasModel: false,
      onPath: { 'llama-server': '/usr/local/bin/llama-server', 'clm-serve': '/usr/local/bin/clm-serve' },
    })

    // No model yet: the help says where to download it, and no process is touched.
    const missing = await $.command.run({ command: 'clm', args: 'restart', ...RUN })

    expect(missing.text).toContain('hf download Qwen/Qwen3-8B-GGUF Qwen3-8B-Q4_K_M.gguf --local-dir "/home/tester/.cache/clm/models"')
    expect(services(runs).filter(r => r.script !== 'listeners')).toHaveLength(0)

    expect((await $.command.run({ command: 'clm', args: 'encoder /usr/share/models/qwen3.gguf', ...RUN })).text).toContain(
      'Encoder model: /usr/share/models/qwen3.gguf',
    )
    const said = await $.command.run({ command: 'clm', args: 'riavvia', ...RUN })
    const starts = runs.filter(r => r.script === 'start')

    expect(said.text).toContain('encoder started')
    expect(starts.map(r => r.argv[0])).toEqual(['sh', 'sh'])
    expect(starts[0]?.env.CLM_CMDLINE).toBe(
      "exec '/usr/local/bin/llama-server' -m '/usr/share/models/qwen3.gguf' --embeddings --pooling last -ngl 99 -c 2048 -b 2048 -ub 2048 --host 127.0.0.1 --port 8090 --alias qwen3-8b -np 2 -fa on -ctk q8_0 -ctv q8_0 > '/home/tester/.cache/clm/logs/encoder.log' 2>&1",
    )
    expect(starts[1]?.env.CLM_CMDLINE).toContain("exec '/usr/local/bin/clm-serve'")
    expect(starts[0]?.env.CLM_LOGDIR).toBe('/home/tester/.cache/clm/logs')
  })

  test('without clm-serve anywhere, restart says how to install it', async ($, on) => {
    fakeServer(on)
    const runs = fakeHost(on, { platform: 'posix', onPath: { 'llama-server': '/usr/local/bin/llama-server' } })
    const said = await $.command.run({ command: 'clm', args: 'restart', ...RUN })

    expect(said.text).toContain('pip install contrastive-lm')
    expect(runs.filter(r => r.script === 'start')).toHaveLength(0)
  })

  test('encoder-args are saved and used on the next start; what the mod sets itself, or a shell operator, is refused', async ($, on) => {
    fakeServer(on)
    const runs = fakeHost(on)

    expect((await $.command.run({ command: 'clm', args: 'encoder-args', ...RUN })).text).toContain('-np 2 -fa on -ctk q8_0 -ctv q8_0')
    expect((await $.command.run({ command: 'clm', args: 'encoder-args -np 4 -fa on', ...RUN })).text).toContain('Encoder options: -np 4 -fa on')

    for (const refused of ['--host 0.0.0.0', '-np 2 --port 9000', '-m other.gguf', '--pooling mean', '-np 2 & calc', '-np "2"', '-np 2; id']) {
      expect((await $.command.run({ command: 'clm', args: `encoder-args ${refused}`, ...RUN })).text).toContain('not allowed')
    }

    await $.command.run({ command: 'clm', args: 'restart', ...RUN })
    const encoder = runs.filter(r => r.script === 'start').map(r => r.env.CLM_CMDLINE ?? '')[0] ?? ''

    expect(encoder).toContain('--alias qwen3-8b -np 4 -fa on >')
    expect(encoder).not.toContain('q8_0')
    expect((await $.command.run({ command: 'clm', args: 'services', ...RUN })).text).toContain('encoder options: -np 4 -fa on')
    expect((await $.command.run({ command: 'clm', args: 'encoder-args default', ...RUN })).text).toContain('-np 2 -fa on -ctk q8_0 -ctv q8_0')
  })

  test('restart stops and explains when Qwen3-8B is missing, touching no process', async ($, on) => {
    fakeServer(on)
    const runs = fakeHost(on, { hasModel: false })
    const said = await $.command.run({ command: 'clm', args: 'restart', ...RUN })

    expect(said.text).toContain('Encoder model missing')
    expect(said.text).toContain('Qwen/Qwen3-8B-GGUF')
    expect(services(runs).filter(r => r.script !== 'listeners')).toHaveLength(0)
  })

  test('restart leaves a foreign process on the port alone, and starts nothing', async ($, on) => {
    fakeServer(on)
    const runs = fakeHost(on, { isPortTaken: true })
    const said = await $.command.run({ command: 'clm', args: 'restart', ...RUN })

    expect(said.text).toContain('held by nginx')
    expect(runs.filter(r => r.script === 'start')).toHaveLength(0)
  })

  test('is off until switched on, its tools refuse, and off makes no CLM call at all', async ($, on) => {
    const hits = fakeServer(on)
    const ran = await callTool($, { tool: 'mcp__clm__rank', context: 'tides', candidates: ['The Moon', 'The Sun'] })

    expect(JSON.stringify(ran)).toContain('switched off')

    const status = await $.command.run({ command: 'clm', args: 'status', ...RUN })

    expect(status.text).toContain('**CLM-8B off**')
    expect(status.text).toContain('| Tools for the model | ⬜ off |')
    expect(hits.health + hits.rank + hits.systemone).toBe(0)
  })

  test('/clm on, then rank answers by candidate number, with latency, shown above the prompt with its bar', async ($, on) => {
    fakeServer(on)
    const turnedOn = await $.command.run({ command: 'clm', args: 'on', ...RUN })

    expect(turnedOn.text).toContain('CLM-8B on. heads: clm-latest, clm-raw')

    const ran = await callTool($, { tool: 'mcp__clm__rank', context: 'tides', candidates: ['The Moon', 'The Sun'] })
    const said = ran.text ?? JSON.stringify(ran.result)

    expect(said).toContain('95.0%  #1  The Moon')
    expect(said).toContain('server 13 ms')

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'clm', surface, ...BAND })

      // The best candidate's number, its probability as a bar, and its text: once each.
      expect(await ui.find({ type: 'Text', text: /^#1 $/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^█{7}/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^ ?95\.0%$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: ' · «The Moon»' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'TOOL' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('/clm off stops every call again', async ($, on) => {
    fakeServer(on)
    await $.command.run({ command: 'clm', args: 'on', ...RUN })
    await $.command.run({ command: 'clm', args: 'off', ...RUN })
    const ran = await callTool($, { tool: 'mcp__clm__ask', state: 's', questions: { q: { type: 'noul', instructions: 'x' } } })

    expect(JSON.stringify(ran)).toContain('switched off')
  })

  test('CLM_API_KEY travels as a bearer header, and the chosen head as the request\'s model', async ($, on) => {
    const hits = fakeServer(on)
    fakeHost(on, { env: { CLM_API_KEY: 'test-key-123' } })
    await $.command.run({ command: 'clm', args: 'on', ...RUN })

    expect((await $.command.run({ command: 'clm', args: 'model nope', ...RUN })).text).toContain('does not serve «nope»')
    await $.command.run({ command: 'clm', args: 'model clm-raw', ...RUN })
    await callTool($, { tool: 'mcp__clm__rank', context: 'tides', candidates: ['The Moon', 'The Sun'] })

    expect(hits.requests[0]?.headers.authorization).toBe('Bearer test-key-123')
    expect(hits.requests[0]?.body.model).toBe('clm-raw')

    await $.command.run({ command: 'clm', args: 'model default', ...RUN })
    await callTool($, { tool: 'mcp__clm__rank', context: 'tides', candidates: ['The Moon', 'The Sun'] })

    expect(hits.requests[1]?.body.model).toBe(undefined)
  })

  test('CLM_BASE_URL stands in for the default URL', async ($, on) => {
    const hits = fakeServer(on)
    fakeHost(on, { env: { CLM_BASE_URL: 'http://gpu-box.test:9000' } })
    await startSession($, on)
    await $.command.run({ command: 'clm', args: 'on', ...RUN })
    await callTool($, { tool: 'mcp__clm__rank', context: 'tides', candidates: ['The Moon', 'The Sun'] })

    expect(hits.requests[0]?.url).toBe('http://gpu-box.test:9000/v1/rank')
  })

  test('the check sends at most 1500 characters: the command head, then the tail of the output', async ($, on) => {
    const hits = fakeServer(on, { failure: 0.95 })
    fakeBash(on, `${'build log line\n'.repeat(600)}${FAILED_TESTS}`)
    await $.command.run({ command: 'clm', args: 'on', ...RUN })
    await callTool($, { tool: 'Bash', command: `npm test ${'--verbose '.repeat(60)}`, description: 'Run tests' })

    expect(hits.states).toHaveLength(1)
    expect(hits.states[0]?.length ?? 0).toBeLessThanOrEqual(1500)
    expect(hits.states[0]?.startsWith('$ npm test')).toBe(true)
    expect(hits.states[0]).toContain('3 failed, 12 passed in 2.1s')
  })

  test('a Bash output that reads like a failure gets a note for the model, flagged in the band', async ($, on) => {
    fakeServer(on, { failure: 0.95 })
    fakeBash(on, FAILED_TESTS)
    await $.command.run({ command: 'clm', args: 'on', ...RUN })

    const ran = await callTool($, { tool: 'Bash', command: 'npm test', description: 'Run tests' })

    expect((ran.context ?? []).join('\n')).toContain('[CLM-8B verifier]')
    expect((ran.context ?? []).join('\n')).toContain('was not reported as an error')

    const ui = await $.ui.mount({ plugin: 'clm', surface: 'desktop', ...BAND })

    expect(await ui.find({ type: 'Text', text: 'note sent to the model' })).toBeDefined()
    // The headline is the failure's probability, in the color of a value over its threshold.
    expect((await ui.find({ type: 'Text', text: /^ ?95\.0%$/ }))?.props.color).toBe('error')
    await ui.unmount()
  })

  test('an output with no sign of failure is not even sent to CLM', async ($, on) => {
    const hits = fakeServer(on, { failure: 0.95 })
    fakeBash(on, 'All 15 tests passed in 2.1s, nothing to report')
    await $.command.run({ command: 'clm', args: 'on', ...RUN })

    const ran = await callTool($, { tool: 'Bash', command: 'npm test', description: 'Run tests' })

    expect(ran.context ?? []).toEqual([])
    expect(hits.systemone).toBe(0)
  })

  test('a plain read is never checked, whatever its output says', async ($, on) => {
    const hits = fakeServer(on, { failure: 0.99 })
    fakeBash(on, 'throw new Error("connection refused"); // failed to connect')
    await $.command.run({ command: 'clm', args: 'on', ...RUN })

    for (const command of ['cd src && grep -n "Error" server.ts | head -20', 'sed -n 80,156p server.py', 'git log --oneline -5']) {
      const ran = await callTool($, { tool: 'Bash', command, description: 'Read' })

      expect(ran.context ?? []).toEqual([])
    }

    expect(hits.systemone).toBe(0)

    // A redirection into a file writes: no longer a plain read.
    await callTool($, { tool: 'Bash', command: 'grep -n Error server.ts > out.txt', description: 'Write' })

    expect(hits.systemone).toBe(1)
  })

  test('the guard scores a command that will ask for permission, without its description', async ($, on) => {
    const hits = fakeServer(on, { decision: 'ask' })
    await $.command.run({ command: 'clm', args: 'on', ...RUN })

    // The permission decision for a real call (a tool_use_id), as the engine raises it.
    const verdict = await $.tool.check({
      tool: 'Bash',
      input: { command: 'rm -rf build', description: 'Run the tests safely' },
      tool_use_id: 'toolu_guard_test',
    })

    expect(verdict.decision).toBe('ask') // advisory: the verdict passes on unchanged
    expect(hits.states.some(state => state.includes('$ rm -rf build'))).toBe(true)
    expect(hits.states.some(state => state.includes('Run the tests safely'))).toBe(false)

    // A query (no tool_use_id) has no dialog to annotate: no CLM call.
    const before = hits.systemone
    await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf dist' } })

    expect(hits.systemone).toBe(before)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'clm', surface, ...PANE })

      expect(await ui.findAll({ type: 'Text', text: /GUARD/ })).not.toHaveLength(0)
      // Logged as the command itself, not as the prompt CLM was sent.
      expect(await ui.find({ type: 'Text', text: /^\$ rm -rf build\s*$/ })).toBeDefined()
      // The risk (10%) as the headline, under half the 70% threshold: good; CLM's pick beside it.
      expect((await ui.find({ type: 'Text', text: /^\s*10\.0%$/ }))?.props.color).toBe('success')
      // Its meter: a pill where the surface draws Svg, blocks on the terminal.
      if (surface === 'terminal') expect((await ui.find({ type: 'Text', text: /^█$/ }))?.props.color).toBe('success')
      else expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('10.0%')
      expect(await ui.find({ type: 'Text', text: ' · safe' })).toBeDefined()
      // The distribution waits behind ▸ until the row is opened.
      expect(await ui.find({ type: 'Text', text: /^exfiltration/ })).toBeUndefined()

      const row = await ui.find({ type: 'Button', text: /GUARD/ })

      await ui.press({ key: row?.key ?? '' })
      expect(await ui.find({ type: 'Text', text: /^safe$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^exfiltration$/ })).toBeDefined()
      // Pills where the surface draws Svg, blocks on the terminal.
      expect(await ui.findAll({ type: 'Svg' })).toHaveLength(surface === 'terminal' ? 0 : 4)
      expect(await ui.find({ type: 'Text', text: /^server \d+ ms · 20 tok$/ })).toBeDefined()

      // Pressed again, it closes.
      await ui.press({ key: row?.key ?? '' })
      expect(await ui.find({ type: 'Text', text: /^exfiltration/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('the log: stats, a filter per source, a chart off the terminal and a sparkline on it, and clear', async ($, on) => {
    fakeServer(on, { decision: 'ask' })
    await $.command.run({ command: 'clm', args: 'on', ...RUN })
    await $.command.run({ command: 'clm', args: 'test', ...RUN })
    await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'toolu_1' })

    const terminal = await $.ui.mount({ plugin: 'clm', surface: 'terminal', ...PANE })

    expect(await terminal.find({ type: 'Text', text: 'Ready' })).toBeDefined()
    expect(await terminal.find({ type: 'Text', text: /^2 $/ })).toBeDefined()
    expect(await terminal.find({ type: 'Text', text: 'calls' })).toBeDefined()
    expect(await terminal.find({ type: 'Text', text: /^p95 $/ })).toBeDefined()
    expect(await terminal.find({ type: 'Text', text: /^[▁▂▃▄▅▆▇█]{2}$/ })).toBeDefined()
    expect((await terminal.find({ key: 'f-all' }))?.text).toContain('All 2')
    await terminal.press({ key: 'f-guard' })
    expect(await terminal.findAll({ type: 'Text', text: /^TEST/ })).toHaveLength(0)
    expect(await terminal.findAll({ type: 'Text', text: /^GUARD/ })).toHaveLength(1)
    await terminal.press({ key: 'f-all' })
    await terminal.unmount()

    const desktop = await $.ui.mount({ plugin: 'clm', surface: 'desktop', ...PANE })

    expect((await desktop.find({ type: 'Svg' }))?.props.alt).toContain('p50')
    await desktop.press({ key: 'clear' })
    expect(await desktop.find({ type: 'Text', text: /No answers yet/ })).toBeDefined()
    await desktop.unmount()
  })

  test('a refused over-long input is retried once, cut to fit, and the model is told', async ($, on) => {
    const hits = fakeServer(on, { overflowOnce: true })
    await $.command.run({ command: 'clm', args: 'on', ...RUN })

    const state = `${'0123456789abcdef'.repeat(250)}\nthe part that matters is here`
    const ran = await callTool($, { tool: 'mcp__clm__ask', state, questions: { q: { type: 'noul', instructions: 'x' } } })
    const said = ran.text ?? JSON.stringify(ran.result)

    expect(hits.systemone).toBe(2)
    expect(hits.states[1]?.length ?? 0).toBeLessThan(hits.states[0]?.length ?? 0)
    expect(hits.states[1]).toContain('the part that matters is here')
    expect(said).toContain('state cut')
  })

  test('a network failure turns the dot red and pauses the checks instead of paying it on every call', async ($, on) => {
    const hits = fakeServer(on, { isSystemOneDown: true })
    fakeBash(on, FAILED_TESTS)
    engineModes(on)
    await $.command.run({ command: 'clm', args: 'on', ...RUN })

    const first = await callTool($, { tool: 'Bash', command: 'npm test', description: 'Run tests' })
    const second = await callTool($, { tool: 'Bash', command: 'npm test', description: 'Run tests' })

    expect(first.context ?? []).toEqual([])
    expect(second.context ?? []).toEqual([])
    expect(hits.systemone).toBe(1)

    const ui = await $.ui.mount({ plugin: 'clm', surface: 'desktop', ...FOOTER })

    expect((await ui.find(DOT))?.props.color).toBe('error')
    await ui.unmount()

    // The log says it in words, not as the fetch's own message.
    const pane = await $.ui.mount({ plugin: 'clm', surface: 'desktop', ...PANE })

    expect(await pane.find({ type: 'Text', text: 'Offline' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'clm-serve unreachable (connection refused)' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /ECONNREFUSED|\$\.http/ })).toBeUndefined()
    // And it offers the way out, not just the news.
    expect((await pane.find({ key: 'h-restart' }))?.text).toContain('Restart services')
    await pane.unmount()
  })

  test('thresholds are set in percent; switch words ignore case; an unknown verb says so without calling CLM', async ($, on) => {
    const hits = fakeServer(on)

    expect((await $.command.run({ command: 'clm', args: 'guard 60', ...RUN })).text).toContain('warns from 60.0%')
    expect((await $.command.run({ command: 'clm', args: 'check 85%', ...RUN })).text).toContain('notes from 85.0%')
    expect((await $.command.run({ command: 'clm', args: 'guard 150', ...RUN })).text).toContain('Usage: /clm guard on|off|<1-99>')
    expect((await $.command.run({ command: 'clm', args: 'Guard OFF', ...RUN })).text).toContain('| Guard — risk hint under Bash permission prompts | ⬜ off |')

    const unknown = await $.command.run({ command: 'clm', args: 'of', ...RUN })

    expect(unknown.text).toContain('Unknown command «of»')
    expect(unknown.text).toContain('`/clm on · off`')
    expect(hits.health).toBe(0)
  })

  test('/clm help lists every command; /clm clear empties the log', async ($, on) => {
    fakeServer(on)
    await $.command.run({ command: 'clm', args: 'on', ...RUN })
    await $.command.run({ command: 'clm', args: 'test', ...RUN })

    const help = await $.command.run({ command: 'clm', args: 'help', ...RUN })

    // Pipes inside a table cell are escaped.
    for (const verb of ['`/clm restart · stop · services`', 'guard on\\|off\\|<1-99>', 'model <name>\\|default', 'lang auto\\|en\\|it']) expect(help.text).toContain(verb)

    expect((await $.command.run({ command: 'clm', args: 'clear', ...RUN })).text).toContain('log cleared')

    const ui = await $.ui.mount({ plugin: 'clm', surface: 'terminal', ...PANE })

    expect(await ui.find({ type: 'Text', text: /No answers yet/ })).toBeDefined()
    // The empty log teaches: one press runs a test, and its answer fills the log.
    await ui.press({ key: 'empty-test' })
    expect(await ui.find({ type: 'Text', text: /^TEST/ })).toBeDefined()
    await ui.unmount()
  })

  test('switched off, the log offers to turn CLM on', async ($, on) => {
    fakeServer(on)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'clm', surface, ...PANE })

      expect(await ui.find({ type: 'Text', text: 'Off' })).toBeDefined()
      expect(await ui.find({ key: 'empty-test' })).toBeUndefined()
      await ui.press({ key: 'h-on' })
      expect(await ui.find({ type: 'Text', text: 'Ready' })).toBeDefined()
      expect(await ui.find({ key: 'h-on' })).toBeUndefined()
      await $.command.run({ command: 'clm', args: 'off', ...RUN })
      await ui.unmount()
    }
  })

  test("settings from the Italian-only version keep the mod in Italian; /clm lang en switches", async ($, on) => {
    fakeServer(on, { store: { settings: { enabled: false, guard: true, check: true, band: true, url: 'http://127.0.0.1:8700' } } })
    engineModes(on)
    await startSession($, on)

    const ui = await $.ui.mount({ plugin: 'clm', surface: 'desktop', ...FOOTER })

    expect(await ui.find({ type: 'Text', text: 'CLM-8B spento', in: TAG })).toBeDefined()
    expect((await $.command.run({ command: 'clm', args: 'stato', ...RUN })).text).toContain('| Tool per il modello | ⬜ off |')
    expect((await $.command.run({ command: 'clm', args: 'lang en', ...RUN })).text).toBe('Language: English.')
    expect(await ui.find({ type: 'Text', text: 'CLM-8B off', in: TAG })).toBeDefined()
    await ui.unmount()
  })

  test('auto follows an Italian locale', async ($, on) => {
    fakeServer(on)
    fakeHost(on, { env: { LANG: 'it_IT.UTF-8' } })
    engineModes(on)
    await startSession($, on)

    expect((await $.command.run({ command: 'clm', args: 'status', ...RUN })).text).toContain('**CLM-8B spento**')
  })

  test("footer: another plugin's SessionMode tag survives clm", { plugins: [OTHER] }, async ($, on) => {
    fakeServer(on)
    fakeHost(on)
    engineModes(on)

    // Whole text a single space: the gap between what lies beneath and clm's dot (a string would match by inclusion).
    const GAP = { type: 'Text', text: /^ $/ } as const

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'clm', surface, component: 'SessionMode', props: { modes: ['plan mode on'] } })

      // clm's own Client, the other plugin's tag and the engine's mode labels are all drawn.
      expect((await ui.find({ key: TAG }))?.type).toBe('Client')
      expect(await ui.find({ type: 'Text', text: 'CLM-8B off', in: TAG })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'OTHER' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /plan mode on/ })).toBeDefined()
      expect(await ui.find(GAP)).toBeDefined()
      await ui.unmount()
    }

    // The Button fallback draws the same: the others beneath, then clm's dot and button.
    await $.command.run({ command: 'clm', args: 'tag button', ...RUN })

    const ui = await $.ui.mount({ plugin: 'clm', surface: 'desktop', component: 'SessionMode', props: { modes: ['plan mode on'] } })

    expect((await ui.find({ key: 'toggle' }))?.text).toContain('off')
    expect(await ui.find({ type: 'Text', text: 'OTHER' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /plan mode on/ })).toBeDefined()
    expect(await ui.find(GAP)).toBeDefined()
    await ui.unmount()
  })
})
