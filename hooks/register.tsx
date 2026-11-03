import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ClmCall, ClmFilter, ClmHeadline, ClmHealth, ClmLang, ClmOption, ClmServices, ClmSettings, ClmSource, ClmTone } from '../types'
import { bar, fmtMs, latencyChart, meterSvg, MUTED_HEX, percentile, SOURCE_COLOR, sparkline, TONE_COLOR, TONE_HEX } from './draw'
import { isItalian, STRINGS } from './i18n'
import type { Strings } from './i18n'
import {
  backendsDirs,
  clmServeCandidates,
  commandLines,
  DEFAULT_ENCODER_ARGS,
  encoderArgsProblem,
  encoderModelCandidates,
  exeName,
  isUnsafePath,
  join,
  logDir,
  modelsDir,
  orderBackends,
  OWN_PROCESSES,
  parseListeners,
  parseStart,
  parseStop,
  portOf,
  scriptArgv,
  whichArgv,
} from './services'
import type { Host, Problem, ScriptName, ServicePlan, StopEntry } from './services'
import type { TagProps } from './tag'

const DEFAULT_URL = 'http://127.0.0.1:8700'

const DEFAULTS: ClmSettings = {
  enabled: false,
  guard: true,
  check: true,
  band: true,
  url: DEFAULT_URL,
  guardThreshold: 0.7,
  checkThreshold: 0.8,
  timeoutMs: 5000,
  model: null,
  encoderModel: null,
  encoderBin: null,
  clmServeBin: null,
  encoderPort: 8090,
  encoderArgs: DEFAULT_ENCODER_ARGS,
  tagStyle: 'auto',
  lang: 'auto',
}

const settings = atom({ plugin: 'clm', key: 'settings' } as const, DEFAULTS)
const calls = atom({ plugin: 'clm', key: 'calls' } as const, [] as ClmCall[])
const health = atom({ plugin: 'clm', key: 'health' } as const, null as ClmHealth | null)
const services = atom({ plugin: 'clm', key: 'services' } as const, null as ClmServices | null)
const lang = atom({ plugin: 'clm', key: 'lang' } as const, 'en' as ClmLang)
const filter = atom({ plugin: 'clm', key: 'filter' } as const, 'all' as ClmFilter)
const selected = atom({ plugin: 'clm', key: 'selected' } as const, null as string | null)

const PANE = 'clm-log'
const MENU = 'clm-menu'
const TAG_CLIENT = 'clm-tag-client'
// How long the footer waits for the tag's Client to say it mounted before falling back to a Button.
const CLIENT_GRACE_MS = 4000
const RANK_TOOL = 'mcp__clm__rank'
const ASK_TOOL = 'mcp__clm__ask'
const MAX_LOG = 50
// llama-server refuses an input longer than its context (-c 2048) instead of truncating it. Prose
// runs near 3-4 chars per token, but digits, hashes and base64 reach about 1 token per char: these
// caps keep ordinary text under the limit, and a refused input is retried once with a cut sized
// from the token count the refusal reports (see fitted).
const MAX_STATE_CHARS = 5000
const MAX_CANDIDATE_CHARS = 1500
const MAX_QUESTION_CHARS = 500
const TOKEN_BUDGET = 1800
// What the check sends after a Bash command: the command's head, then its output's tail, about 400
// tokens of prose, so a check stays quick and fits a slot even with -np 2 on a 2048-token context.
const CHECK_STATE_CHARS = 1500
// The hooks wait on CLM inside the agent's own work, so they get short limits; the model's own
// rank/ask calls get a longer one, since the model is explicitly waiting for the answer.
const GUARD_TIMEOUT_MS = 1500
const CHECK_TIMEOUT_MS = 2000
const TOOL_TIMEOUT_MS = 20_000
// After a hook's request times out, the hooks pause for 15 s, then 30 s, 60 s... up to 5 minutes.
const PAUSE_BASE_MS = 15_000
const PAUSE_MAX_MS = 300_000
const MAX_HOOK_REQUESTS = 2
// The log's chevron and time column ("▸ 14:02:11 "), in cells: the lines under a call start below its badge.
const INDENT = 11

const OFF_REASON = 'CLM-8B is switched off by the user (/clm on to enable it). Carry on without it.'

const LIMITS =
  'It reads only the last ~5000 characters of the context/state and the first 1500 of each candidate, ' +
  'and the result says when it cut: put what matters there, and the question in question/instructions.'

const RANK_DESCRIPTION = [
  'Rank candidate options against a context with CLM-8B, a local contrastive verifier',
  '(tens of milliseconds for short texts, up to a few seconds for many long candidates).',
  'Use it to pick the best of several candidates you wrote yourself (plans, patches, shell commands, answers, file paths to inspect first),',
  'to shortlist a large set before reading in depth, or as a quick second opinion between close alternatives.',
  'Returns each candidate, by its number in your list, with its probability of being the best match, and the latency.',
  LIMITS,
  'It only compares the texts you give it and knows nothing else: treat the ranking as a signal, not as ground truth.',
].join(' ')

const ASK_DESCRIPTION = [
  'Ask CLM-8B typed questions about a state (a log, a diff, a message, a tool output).',
  'Each question is {type: "noul", instructions} for a yes/no probability,',
  '{type: "choice", instructions, criteria: {option: description}} to pick one option,',
  'or {type: "score", instructions, criteria: [level0, level1, ...]} for an ordered rating.',
  'Local and fast (tens of milliseconds for short states).',
  LIMITS,
  'Answers are probability distributions, a signal to weigh rather than a verdict.',
].join(' ')

const TEST_CONTEXT = 'What causes tides on Earth?'
const TEST_CANDIDATES = ["The Moon's gravitational pull.", 'Photosynthesis in plants.', 'Because the Earth is round.']

type Engine = EngineInterface

type Timed<T> = { body: T; clientMs: number; serverMs: number | null }

type RankBody = { ranked: { rank: number; candidate: string; prob: number }[] }

type Answer = {
  type: 'noul' | 'choice' | 'score'
  noul?: number
  choice?: string
  confidence?: number
  score?: number
  probabilities?: Record<string, number>
  legend?: Record<string, string>
}

type SystemOneBody = { answers: Record<string, Answer>; usage?: { input_tokens?: number } }

let sequence = 0

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat
}

function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max)}` : text
}

function head(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function pct(p: number): string {
  const v = p * 100

  return `${v >= 99.5 || v < 0.5 ? v.toFixed(0) : v.toFixed(1)}%`
}

function ms(call: Pick<ClmCall, 'clientMs' | 'serverMs'>): string {
  return call.serverMs === null ? fmtMs(call.clientMs) : `${fmtMs(call.clientMs)} (server ${fmtMs(call.serverMs)})`
}

function clock(at: number): string {
  const d = new Date(at)
  const two = (n: number) => String(n).padStart(2, '0')

  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

async function words($: Engine): Promise<Strings> {
  return STRINGS[await read($, lang)]
}

/** The encoder refused a text for its length; `tokens` is the size it counted. */
class Overflow extends Error {
  readonly tokens: number

  constructor(tokens: number) {
    super(`input of ${tokens} tokens over the encoder's 2048`)
    this.tokens = tokens
  }
}

/** No answer within the time the caller allowed. */
class Timeout extends Error {
  readonly ms: number

  constructor(ms: number) {
    super(`no answer within ${ms} ms`)
    this.ms = ms
  }
}

// What the host's fetch says when nothing answers at the address: a code, or Bun's own words.
const NET_ERROR = /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN)\b|Unable to connect|fetch failed|socket hang up/i

/** A network failure in a few words ("connection refused", "ENOTFOUND"); null for any other error. */
function netReason(error: unknown, tr: Strings): string | null {
  const message = error instanceof Error ? error.message : String(error)
  const code = NET_ERROR.exec(message)?.[0]

  if (code === undefined) return null

  return /ECONNREFUSED|Unable to connect/i.test(message) ? tr.connRefused : code
}

/** An error as the person reads it: a network failure as "clm-serve unreachable (…)", never the fetch's own message. */
function describeError(error: unknown, tr: Strings): string {
  if (error instanceof Timeout) return tr.timeout(error.ms)
  if (error instanceof Overflow) return tr.overflow(error.tokens)

  const net = netReason(error, tr)

  if (net !== null) return tr.serverDown(net)

  return error instanceof Error ? error.message : String(error)
}

/** Why the server counts as down, for the health line. */
function downDetail(error: unknown, tr: Strings): string {
  return tr.serverDown(error instanceof Timeout ? tr.timeout(error.ms) : (netReason(error, tr) ?? describeError(error, tr)))
}

/**
 * Sends `text` through `send`; when the encoder refuses it for its length, sends its tail once
 * more, cut to fit TOKEN_BUDGET by the token count the refusal reported. A refusal costs tens of
 * milliseconds, so the retry is cheap. `isCut` says whether the text that answered was cut.
 */
async function fitted<T>(text: string, max: number, send: (text: string) => Promise<T>): Promise<{ value: T; isCut: boolean }> {
  const first = tail(text, max)

  try {
    return { value: await send(first), isCut: first !== text }
  } catch (error) {
    if (!(error instanceof Overflow)) throw error

    return { value: await send(tail(text, Math.floor((first.length * TOKEN_BUDGET) / error.tokens))), isCut: true }
  }
}

async function withTimeout<T>($: Engine, work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: { cancel: () => void } | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = $.clock.after(timeoutMs, () => reject(new Timeout(timeoutMs)))
  })

  try {
    return await Promise.race([work, timeout])
  } finally {
    timer?.cancel()
  }
}

function baseUrl(s: ClmSettings): string {
  return s.url.replace(/\/+$/, '')
}

/** FastAPI's `{ detail }`, else the body as it came. */
function errorDetail(text: string): string {
  try {
    const detail = (JSON.parse(text) as { detail?: unknown }).detail

    return typeof detail === 'string' ? detail : text
  } catch {
    return text
  }
}

async function post<T>($: Engine, s: ClmSettings, path: string, payload: Record<string, unknown>, timeoutMs = s.timeoutMs): Promise<Timed<T>> {
  // The key is read from the environment at each call and travels only in this header: never
  // stored, drawn or logged.
  const key = await $.env.get('CLM_API_KEY').catch(() => undefined)
  const headers: Record<string, string> = { 'content-type': 'application/json' }

  if (key !== undefined && key !== '') headers.authorization = `Bearer ${key}`

  const startedAt = await $.clock.now()
  const res = await withTimeout(
    $,
    $.http.fetch(`${baseUrl(s)}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(s.model === null ? payload : { ...payload, model: s.model }),
    }),
    timeoutMs,
  )
  const clientMs = Math.round((await $.clock.now()) - startedAt)

  if (!res.ok) {
    // Read the size from the whole body: the encoder's message can sit past what the error keeps.
    const size = /request \((\d+) tokens\) exceeds the available context size/.exec(res.text)

    if (size) throw new Overflow(Number(size[1]))
    if (res.status === 401) throw new Error((await words($)).badKey)

    throw new Error(`HTTP ${res.status}: ${oneLine(errorDetail(res.text), 160)}`)
  }

  const server = Number(res.headers['x-clm-latency-ms'])

  return { body: JSON.parse(res.text) as T, clientMs, serverMs: Number.isFinite(server) ? server : null }
}

async function record($: Engine, call: Omit<ClmCall, 'id' | 'at'>): Promise<ClmCall> {
  sequence += 1
  const at = await $.clock.now()
  // The time keeps ids apart across reloads, which start the sequence over while the log stays.
  const full: ClmCall = { ...call, id: `${at}-${sequence}`, at }
  await update($, calls, list => [full, ...list].slice(0, MAX_LOG))
  await syncStatus($)

  return full
}

type Lamp = { glyph: string; emoji: string; color: string | null; label: string }

function lamp(s: ClmSettings, probe: ClmHealth | null, tr: Strings): Lamp {
  if (!s.enabled) return { glyph: '○', emoji: '⚪', color: null, label: tr.lampOff }
  if (probe === null) return { glyph: '◌', emoji: '🟡', color: 'warning', label: tr.lampChecking }
  if (!probe.ok) return { glyph: '●', emoji: '🔴', color: 'error', label: tr.lampOffline }

  return probe.isMock === true
    ? { glyph: '●', emoji: '🟡', color: 'warning', label: tr.lampMock }
    : { glyph: '●', emoji: '🟢', color: 'success', label: tr.lampReady }
}

// True once the footer's SessionMode site has drawn our clickable tag; module state, so a reload
// resets it and the status line shows again until the footer draws.
let isFooterDrawn = false

// The footer tag is a Client (right click opens the menu) wherever the surface proves it draws
// one by posting "mounted"; with no word within CLIENT_GRACE_MS it falls back to a Button.
let isClientConfirmed = false
let isClientRefused = false
let isGraceArmed = false

// The status line is plain text (no click, no color but the emoji's): it stands in for the
// footer tag only where the footer site is not drawn.
async function syncStatus($: Engine): Promise<void> {
  if (isFooterDrawn) {
    $.ui.status(undefined)

    return
  }

  const s = await read($, settings)
  const probe = await read($, health)
  const { emoji, label } = lamp(s, probe, await words($))
  const last = s.enabled ? (await read($, calls))[0] : undefined
  // A latency only next to "ready": next to "offline" it would read as a fast answer.
  $.ui.status(probe?.ok === true && last?.ok ? `${emoji} ${label} · ${fmtMs(last.clientMs)}` : `${emoji} ${label}`)
}

async function failed($: Engine, source: ClmSource, kind: ClmCall['kind'], subject: string, error: unknown, note?: string): Promise<ClmCall> {
  const tr = await words($)
  const message = note === undefined ? describeError(error, tr) : `${describeError(error, tr)} · ${note}`

  return record($, {
    source,
    kind,
    subject,
    answer: tr.noAnswer,
    detail: [message],
    clientMs: 0,
    serverMs: null,
    tokens: null,
    ok: false,
    error: message,
  })
}

/** One ranked candidate: `index` is its place in the caller's list, `candidate` its full text. */
type Ranked = { index: number; prob: number; candidate: string }

async function rank(
  $: Engine,
  s: ClmSettings,
  source: ClmSource,
  context: string,
  candidates: string[],
  question = '',
  timeoutMs = s.timeoutMs,
) {
  const q = head(question, MAX_QUESTION_CHARS)
  const sent = candidates.map(c => head(c, MAX_CANDIDATE_CHARS))
  // The server's state is context + question, so the question's room comes out of the context's.
  const {
    value: { body, clientMs, serverMs },
    isCut,
  } = await fitted(context, Math.max(500, MAX_STATE_CHARS - q.length), text =>
    post<RankBody>($, s, '/v1/rank', { context: text, question: q, answers: sent }, timeoutMs),
  )
  // The server answers with the texts it was sent; map each back to its place in the caller's list.
  const used = new Set<number>()
  const ranked: Ranked[] = body.ranked.map(r => {
    let index = sent.findIndex((c, i) => !used.has(i) && c === r.candidate)

    if (index < 0) index = sent.findIndex((_, i) => !used.has(i))
    used.add(index)

    return { index, prob: r.prob, candidate: candidates[index] ?? r.candidate }
  })
  const cutCandidates = candidates.flatMap((c, i) => (c.length > MAX_CANDIDATE_CHARS ? [i + 1] : []))
  const notes = [
    isCut ? 'context cut to its last part' : '',
    cutCandidates.length > 0 ? `candidates ${cutCandidates.join(', ')} cut to their first ${MAX_CANDIDATE_CHARS} characters` : '',
    q !== question ? `question cut to its first ${MAX_QUESTION_CHARS} characters` : '',
  ].filter(note => note !== '')
  const best = ranked[0]
  const tr = await words($)
  const call = await record($, {
    source,
    kind: 'rank',
    subject: oneLine(question === '' ? context : `${question} — ${context}`, 160),
    // The probability is the headline's, drawn beside it as a bar.
    answer: best ? `#${best.index + 1} «${oneLine(best.candidate, 60)}»` : tr.noCandidate,
    detail: ranked.slice(0, 8).map(r => `${pct(r.prob).padStart(6)}  #${r.index + 1} ${oneLine(r.candidate, 90)}`),
    dist: ranked.slice(0, 8).map(r => ({ label: `#${r.index + 1} ${oneLine(r.candidate, 40)}`, p: r.prob })),
    ...(best ? { headline: { label: `#${best.index + 1}`, p: best.prob, tone: 'neutral' as const, verdict: `«${oneLine(best.candidate, 120)}»` } } : {}),
    clientMs,
    serverMs,
    tokens: null,
    ok: true,
    error: null,
  })

  return { ranked, call, notes }
}

function describeAnswer(id: string, a: Answer, isOnly: boolean, tr: Strings): string {
  const named = (text: string) => (isOnly ? text : `${id}: ${text}`)

  if (a.type === 'noul') return named(`${pct(a.noul ?? 0)} ${tr.yes}`)
  if (a.type === 'choice') return named(`${a.choice} ${pct(a.probabilities?.[a.choice ?? ''] ?? 0)}`)

  const levels = Object.keys(a.probabilities ?? {}).length

  return named(tr.outOf((a.score ?? 0).toFixed(2), Math.max(0, levels - 1)))
}

function answerDetail(id: string, a: Answer, tr: Strings): string[] {
  if (a.type === 'noul') return [`${id}  ${tr.yes} ${pct(a.noul ?? 0)} · ${tr.no} ${pct(1 - (a.noul ?? 0))}`]

  return Object.entries(a.probabilities ?? {}).map(([option, p]) => {
    const label = a.legend?.[option] ?? option

    return `${id}  ${pct(p).padStart(6)}  ${oneLine(label, 70)}`
  })
}

/** An answer's options for the bars: a choice best first, a score's levels in their order. */
function answerDist(id: string, a: Answer, isOnly: boolean, tr: Strings): ClmOption[] {
  const group = isOnly ? {} : { group: id }

  // Terms, not words: the drawing translates them, so a later change of language reaches old calls too.
  if (a.type === 'noul') return [{ label: 'yes', p: a.noul ?? 0, ...group }, { label: 'no', p: 1 - (a.noul ?? 0), ...group }]

  const options = Object.entries(a.probabilities ?? {}).map(([option, p]) => ({
    label: a.type === 'score' ? oneLine(a.legend?.[option] ?? option, 24) : option,
    p,
    ...group,
  }))

  return a.type === 'choice' ? options.sort((x, y) => y.p - x.p) : options
}

/** How a hook's own question is logged: its time limit, the line shown for it, and the number it is about. */
type AskOptions = {
  timeoutMs?: number
  /** The log's line for the call; the state's start when absent. */
  subject?: string
  headline?: (answers: Record<string, Answer>) => ClmHeadline | undefined
}

async function ask($: Engine, s: ClmSettings, source: ClmSource, state: string, questions: Record<string, unknown>, options: AskOptions = {}) {
  const { timeoutMs = s.timeoutMs, subject, headline } = options
  const {
    value: { body, clientMs, serverMs },
    isCut,
  } = await fitted(state, MAX_STATE_CHARS, text =>
    post<SystemOneBody>($, s, '/v1/systemone', { state: text, questions }, timeoutMs),
  )
  const tr = await words($)
  const entries = Object.entries(body.answers)
  const isOnly = entries.length === 1
  const top = headline?.(body.answers)
  const call = await record($, {
    source,
    kind: 'systemone',
    subject: oneLine(subject ?? state, 160),
    answer: entries.map(([id, a]) => describeAnswer(id, a, isOnly, tr)).join(' · '),
    detail: entries.flatMap(([id, a]) => answerDetail(id, a, tr)),
    dist: entries.flatMap(([id, a]) => answerDist(id, a, isOnly, tr)),
    ...(top === undefined ? {} : { headline: top }),
    clientMs,
    serverMs,
    tokens: body.usage?.input_tokens ?? null,
    ok: true,
    error: null,
  })

  return { answers: body.answers, call, isCut }
}

/** What CLM picked, as the person reads it: a term translated (safe → sicuro), a candidate's text as it is. */
function verdictOf(top: ClmHeadline, tr: Strings): string {
  return top.verdict === undefined || top.verdict === '' ? '' : (tr.term[top.verdict] ?? top.verdict)
}

/** Tone of a probability that is bad news: fine below half its threshold, worth a look below it, bad from it. */
function toneOf(p: number, threshold: number): ClmTone {
  return p >= threshold ? 'bad' : p >= threshold / 2 ? 'warn' : 'good'
}

async function quickTest($: Engine, s: ClmSettings) {
  return rank($, s, 'test', TEST_CONTEXT, TEST_CANDIDATES)
}

async function ping($: Engine): Promise<ClmHealth> {
  const s = await read($, settings)
  const tr = await words($)
  let result: ClmHealth

  try {
    const res = await withTimeout($, $.http.fetch(`${baseUrl(s)}/health`), 3000)
    const body = res.ok ? (JSON.parse(res.text) as { ok?: boolean; embedder?: boolean; models?: unknown; mock?: boolean }) : null
    const isUp = body?.ok === true && body.embedder === true
    const models = Array.isArray(body?.models) ? body.models.filter((m): m is string => typeof m === 'string') : []
    const detail = body === null ? `HTTP ${res.status}` : isUp ? tr.healthModels(models) : tr.healthNoEncoder
    result = { ok: isUp, at: await $.clock.now(), detail, models, ...(body?.mock === true ? { isMock: true } : {}) }
  } catch (error) {
    const prev = await read($, health)
    result = { ok: false, at: await $.clock.now(), detail: downDetail(error, tr), models: prev?.models ?? [] }
  }

  await update($, health, () => result)
  await syncStatus($)

  return result
}

// The hooks' circuit breaker, module state (a reload starts it closed). The guard and the check
// run inside the agent's own work, so a slow or hung encoder must cost one timeout per pause, not
// one per Bash call; the model's own rank/ask calls stay outside it.
let hookRequests = 0
let pausedUntil = 0
let strikes = 0

/** Whether the guard and the check may call CLM now: server ready, not paused, not saturated. */
async function hooksMayCall($: Engine): Promise<boolean> {
  const probe = await read($, health)

  return probe?.ok === true && hookRequests < MAX_HOOK_REQUESTS && (await $.clock.now()) >= pausedUntil
}

/**
 * Runs one hook request through the breaker and never throws. A timeout pauses the hooks with
 * backoff (15 s, 30 s, ... 5 min); a network error marks the server offline, so the dot turns red
 * and the 5 s poll turns it green again; an HTTP error is logged alone; a success resets it.
 */
async function throughBreaker<T>($: Engine, source: ClmSource, subject: string, work: () => Promise<T>): Promise<T | undefined> {
  hookRequests += 1

  try {
    const value = await work()
    strikes = 0

    return value
  } catch (error) {
    try {
      const tr = await words($)

      if (error instanceof Timeout) {
        strikes += 1
        const pause = Math.min(PAUSE_MAX_MS, PAUSE_BASE_MS * 2 ** (strikes - 1))
        pausedUntil = (await $.clock.now()) + pause
        await failed($, source, 'systemone', subject, error, tr.paused(Math.round(pause / 1000)))
      } else if (error instanceof Overflow || (error instanceof Error && error.message.startsWith('HTTP '))) {
        await failed($, source, 'systemone', subject, error)
      } else {
        const at = await $.clock.now()
        await update($, health, prev => ({ ok: false, at, detail: downDetail(error, tr), models: prev?.models ?? [] }))
        await failed($, source, 'systemone', subject, error)
      }
    } catch {
      // Logging a failure must not become one.
    }

    return undefined
  } finally {
    hookRequests -= 1
  }
}

async function saveSettings($: Engine, change: Partial<ClmSettings>): Promise<ClmSettings> {
  const next = await update($, settings, s => ({ ...s, ...change }))
  await $.store.set('settings', next)
  $.ui.invalidate('tool.describe')
  await syncStatus($)

  return next
}

/** On: the dot goes yellow at once, then green or red as the health check answers. */
async function setEnabled($: Engine, enabled: boolean): Promise<ClmHealth | null> {
  if (enabled) {
    await update($, health, () => null)
  }

  await saveSettings($, { enabled })

  return enabled ? ping($) : null
}

/**
 * The person's language when settings say auto: Claude Code's own `language` setting, then the
 * locale variables, then (Windows sets none of them) the account's locale in the registry.
 */
async function detectLang($: Engine): Promise<ClmLang> {
  try {
    const chosen = await $.settings.read({ key: 'language' })

    if (typeof chosen === 'string' && chosen.trim() !== '' && chosen !== 'auto') return isItalian(chosen) ? 'it' : 'en'
  } catch {
    // No settings to read here.
  }

  try {
    for (const value of [await $.env.get('LC_ALL'), await $.env.get('LC_MESSAGES'), await $.env.get('LANG')]) {
      if (value !== undefined && value !== '' && !/^(C|POSIX)([.@]|$)/.test(value)) return isItalian(value) ? 'it' : 'en'
    }

    if ((await $.env.get('OS')) === 'Windows_NT') {
      const ran = await $.process.run(['reg', 'query', 'HKCU\\Control Panel\\International', '/v', 'LocaleName'], { timeoutMs: 3000 })

      return /LocaleName\s+REG_SZ\s+it-/i.test(ran.stdout) ? 'it' : 'en'
    }
  } catch {
    // No environment to read here.
  }

  return 'en'
}

async function applyLang($: Engine, s: ClmSettings): Promise<ClmLang> {
  const resolved = s.lang === 'auto' ? await detectLang($) : s.lang
  await update($, lang, () => resolved)
  await syncStatus($)

  return resolved
}

/** "60", "60%" or "0.6" as a threshold in (0, 1); null for anything else. */
function parseThreshold(text: string): number | null {
  const match = /^(\d{1,2}(?:[.,]\d+)?)%?$|^(0[.,]\d+)$/.exec(text)

  if (match === null) return null

  const value = match[1] !== undefined ? Number(match[1].replace(',', '.')) / 100 : Number((match[2] ?? '').replace(',', '.'))

  return value > 0 && value < 1 ? value : null
}

// A command whose every segment only reads (prints files, lists, searches, inspects git) has no
// silent failure to catch, and its output (source, logs, docs) is full of words like "error".
const READ_VERB =
  /^(cd|cat|type|head|tail|less|more|sed\s+-n|awk|grep|egrep|fgrep|rg|ls|dir|tree|find(?![^|]*\s-(delete|exec|execdir|ok)\b)|wc|cut|sort|uniq|echo|printf|pwd|which|where|stat|file|du|df|date|env|printenv|Get-Content|Get-ChildItem|Select-String|Test-Path|git\s+(show|diff|log|status|branch|grep|blame|rev-parse|ls-files|remote))\b/i

function isPlainRead(command: string): boolean {
  const unquoted = command.replace(/"(\\.|[^"\\])*"|'[^']*'/g, '""')

  // Heredocs, command substitution and redirections into files can write: never a plain read.
  if (/<<|\$\(|`|>{1,2}\s*(?!&\d|\/dev\/null|nul\b)[^\s&]/i.test(unquoted)) return false

  return unquoted.split(/&&|\|\||;|\||\n/).every(part => {
    const segment = part
      .trim()
      .replace(/^(\w+=\S*\s+)+/, '')
      .replace(/^(rtk\s+(proxy\s+)?|timeout\s+\d+\s+|time\s+)/, '')
      .replace(/\s*\d?>&?\s*(\/dev\/null|nul|&\d)\b/gi, '')
      .trim()

    return segment === '' || READ_VERB.test(segment)
  })
}

// What a failure's output says somewhere; an output with none of these is not worth a CLM call.
const FAILURE_CUE =
  /\b(error|errors|fail(ed|ure|ures|ing|s)?|exception|traceback|panic|fatal|denied|refused|cannot|could not|unable|not found|no such file|segmentation fault|aborted|exit (code|status) [1-9]\d*|errore|fallit[oaie]|impossibile)\b|npm ERR!/i

// Each load of the module draws the tag with a new epoch, so the tag's Client says "mounted" again
// after a hot reload even though the surface keeps the instance and its state.
let loadEpoch = 0

const EMPTY_SERVICES: ClmServices = { at: 0, encoder: null, serve: null, busy: null, lines: [] }

/** The platform from OS (Windows_NT on every Windows), the home folder from its own variable. */
async function hostOf($: Engine): Promise<Host> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const home = (isWindows ? await $.env.get('USERPROFILE') : await $.env.get('HOME')) ?? ''

  return { platform: isWindows ? 'windows' : 'posix', home }
}

async function runScript($: Engine, platform: Host['platform'], script: ScriptName, env: Record<string, string>) {
  return $.process.run(scriptArgv(platform, script), { env, timeoutMs: 30_000 })
}

/** Where a program is on PATH, if anywhere: the first line `where`/`command -v` prints. */
async function findOnPath($: Engine, host: Host, name: 'llama-server' | 'clm-serve'): Promise<string | null> {
  try {
    const ran = await $.process.run(whichArgv(host.platform, name), { timeoutMs: 5_000 })
    const first = ran.stdout.split(/\r?\n/).map(line => line.trim()).find(line => line !== '')

    return ran.exitCode === 0 && first !== undefined ? first : null
  } catch {
    return null
  }
}

/** The configured llama-server, else the best llama.cpp backend LM Studio installed, else PATH's. */
async function findEncoderBin($: Engine, host: Host, s: ClmSettings): Promise<string | null> {
  if (s.encoderBin !== null) return s.encoderBin

  for (const dir of backendsDirs(host)) {
    try {
      const names = (await $.fs.list(dir)).filter(d => d.kind === 'dir').map(d => d.name)

      for (const name of orderBackends(names)) {
        const bin = join(host, dir, name, exeName(host.platform, 'llama-server'))

        if (await $.fs.exists(bin)) return bin
      }
    } catch {
      // No LM Studio backends here.
    }
  }

  return findOnPath($, host, 'llama-server')
}

/** The configured clm-serve, else PATH's, else pipx's. */
async function findClmServe($: Engine, host: Host, s: ClmSettings): Promise<string | null> {
  if (s.clmServeBin !== null) return s.clmServeBin

  const onPath = await findOnPath($, host, 'clm-serve')

  if (onPath !== null) return onPath

  for (const path of clmServeCandidates(host)) {
    if (await $.fs.exists(path)) return path
  }

  return null
}

/** The configured model, else the first Qwen3-8B Q4_K_M found, else where the help downloads it. */
async function findEncoderModel($: Engine, host: Host, s: ClmSettings): Promise<string> {
  if (s.encoderModel !== null) return s.encoderModel

  const candidates = encoderModelCandidates(host)

  for (const path of candidates) {
    if (await $.fs.exists(path)) return path
  }

  return candidates[candidates.length - 1] ?? ''
}

async function planServices($: Engine, s: ClmSettings): Promise<ServicePlan> {
  const host = await hostOf($)
  const { isLocal, port: clmPort } = portOf(s.url)
  const encoderBin = await findEncoderBin($, host, s)
  const encoderModel = await findEncoderModel($, host, s)
  const clmServeBin = await findClmServe($, host, s)
  const problems: Problem[] = []

  if (!isLocal) problems.push({ kind: 'remote', url: s.url })
  if (encoderBin === null) problems.push({ kind: 'no-llama' })
  if (!(await $.fs.exists(encoderModel))) problems.push({ kind: 'no-model', model: encoderModel, dir: modelsDir(host) })
  if (clmServeBin === null) problems.push({ kind: 'no-serve' })

  for (const path of [encoderBin ?? '', encoderModel, clmServeBin ?? '', host.home]) {
    if (isUnsafePath(host.platform, path)) problems.push({ kind: 'unsafe-path', path })
  }

  const argsProblem = encoderArgsProblem(s.encoderArgs)

  if (argsProblem !== null) problems.push({ kind: 'bad-args', reason: argsProblem })

  return {
    platform: host.platform,
    isLocal,
    encoderBin,
    encoderModel,
    clmServeBin,
    encoderPort: s.encoderPort,
    encoderArgs: s.encoderArgs,
    clmPort,
    logDir: logDir(host),
    problems,
  }
}

async function inspectServices($: Engine, plan: ServicePlan): Promise<Pick<ClmServices, 'encoder' | 'serve'>> {
  const ran = await runScript($, plan.platform, 'listeners', { CLM_PORTS: `${plan.encoderPort},${plan.clmPort}` })
  const found = parseListeners(ran.stdout)

  return { encoder: found.get(plan.encoderPort) ?? null, serve: found.get(plan.clmPort) ?? null }
}

async function stopServices($: Engine, plan: ServicePlan): Promise<StopEntry[]> {
  const ran = await runScript($, plan.platform, 'stop', { CLM_PORTS: `${plan.encoderPort},${plan.clmPort}`, CLM_OWN: OWN_PROCESSES.join(',') })

  return parseStop(ran.stdout)
}

/** Stops ours on both ports, then starts the encoder and clm-serve detached. */
async function restartServices($: Engine, plan: ServicePlan, tr: Strings): Promise<string[]> {
  if (plan.problems.length > 0) throw new Error(plan.problems.map(tr.problem).join('\n'))

  const stopped = await stopServices($, plan)
  const foreign = stopped.filter(entry => entry.what === 'foreign')

  if (foreign.length > 0) throw new Error(foreign.map(tr.stopLine).join('\n'))

  const lines = commandLines(plan)
  const started: number[] = []

  for (const cmdline of [lines.encoder, lines.serve]) {
    const ran = await runScript($, plan.platform, 'start', { CLM_CMDLINE: cmdline, CLM_LOGDIR: plan.logDir })
    const outcome = parseStart(ran.exitCode, ran.stdout, ran.stderr)

    if (!outcome.ok) throw new Error(tr.startFailed(outcome.code, outcome.stderr))
    started.push(outcome.pid)
  }

  return [
    ...stopped.map(tr.stopLine),
    tr.encoderStarted(started[0] ?? 0, plan.encoderPort),
    tr.serveStarted(started[1] ?? 0, plan.clmPort),
    tr.logsIn(plan.logDir),
  ]
}

/** Who listens on the services' ports now, into the `services` state the menu draws from. */
async function refreshServices($: Engine): Promise<void> {
  const s = await read($, settings)
  const plan = await planServices($, s)
  const at = await $.clock.now()
  const found = plan.isLocal ? await inspectServices($, plan) : { encoder: null, serve: null }

  await update($, services, prev => ({ ...(prev ?? EMPTY_SERVICES), ...found, at }))
}

/**
 * Restarts or stops the two services from the menu or /clm, one action at a time. The menu shows
 * it as busy, then each step's outcome; the dot follows through the health poll.
 */
async function serviceAction($: Engine, what: 'restart' | 'stop'): Promise<string> {
  const tr = await words($)

  if ((await read($, services))?.busy) return tr.otherAction

  const s = await read($, settings)
  let lines: string[]

  await update($, services, prev => ({ ...(prev ?? EMPTY_SERVICES), busy: what === 'restart' ? tr.busyRestart : tr.busyStop, lines: [] }))

  try {
    const plan = await planServices($, s)

    if (what === 'restart') {
      lines = await restartServices($, plan, tr)
      // Yellow until the 5 s poll sees clm-serve and its encoder answer; the encoder takes a while.
      await update($, health, () => null)
      lines.push(s.enabled ? tr.afterRestartOn : tr.afterRestartOff)
    } else {
      const remote = plan.problems.find(p => p.kind === 'remote')

      if (remote !== undefined) throw new Error(tr.problem(remote))

      lines = (await stopServices($, plan)).map(tr.stopLine)
    }
  } catch (error) {
    lines = (error instanceof Error ? error.message : String(error)).split('\n')
  }

  await update($, services, prev => ({ ...(prev ?? EMPTY_SERVICES), busy: null, lines }))
  await refreshServices($).catch(() => undefined)

  if (s.enabled) void ping($).catch(() => undefined)

  // A started encoder binds its port only once the model has loaded: look again then.
  if (what === 'restart') {
    $.clock.after(20_000, () => void refreshServices($).catch(() => undefined))
    $.clock.after(45_000, () => void refreshServices($).catch(() => undefined))
  }

  return lines.join('\n')
}

async function openMenu($: Engine): Promise<void> {
  void refreshServices($).catch(() => undefined)
  await $.ui.open({ id: MENU, title: 'CLM-8B', focus: true, closeOnEscape: true, rows: 24 }).catch(() => undefined)
}

async function openLog($: Engine) {
  return $.ui.open({ id: PANE, title: 'CLM-8B' })
}

/** A table cell: one line, no pipe to split the row. */
function cell(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\|/g, '\\|')
}

/** /clm status: a markdown card the command row draws. */
function statusMarkdown(s: ClmSettings, probe: ClmHealth | null, tr: Strings): string {
  const light = lamp(s, probe, tr)
  const flag = (isOn: boolean) => (isOn ? `✅ ${tr.on}` : `⬜ ${tr.off}`)
  const server = probe === null ? tr.notChecked : probe.ok ? tr.reachable : `${tr.unreachable} — ${probe.detail}`
  const models = probe?.models ?? []

  return [
    `${light.emoji} **${light.label}** · \`${s.url}\` · ${cell(server)}`,
    '',
    `| ${tr.colFeature} | ${tr.colState} | ${tr.colNotes} |`,
    '|---|---|---|',
    `| ${tr.featTools} | ${flag(s.enabled)} | \`rank\` · \`ask\` |`,
    `| ${tr.featGuard} | ${flag(s.guard)} | ${tr.warnFrom(pct(s.guardThreshold))} |`,
    `| ${tr.featCheck} | ${flag(s.check)} | ${tr.noteFrom(pct(s.checkThreshold))} |`,
    `| ${tr.featBand} | ${flag(s.band)} | |`,
    `| ${tr.featHead} | \`${cell(s.model ?? tr.defaultHead)}\` | ${cell(models.join(', '))} |`,
    ...(strikes > 0 ? ['', `⏸ ${tr.pausedAfter(strikes)}`] : []),
    '',
    tr.statusFooter,
  ].join('\n')
}

function helpMarkdown(tr: Strings): string {
  return [tr.helpTitle, '', '| | |', '|---|---|', ...tr.help.map(([command, what]) => `| \`/clm ${cell(command)}\` | ${cell(what)} |`)].join('\n')
}

// Italian and a few English spellings of the same verbs.
const ALIASES: Record<string, string> = {
  stato: 'status',
  aiuto: 'help',
  '?': 'help',
  registro: 'log',
  pulisci: 'clear',
  svuota: 'clear',
  riavvia: 'restart',
  ferma: 'stop',
  servizi: 'services',
  lingua: 'lang',
  language: 'lang',
  head: 'model',
  modello: 'model',
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = (await $.store.get('settings')) as Partial<ClmSettings> | undefined
    // CLM's own client reads CLM_BASE_URL: it stands in for the default URL, never for one set with /clm url.
    const envUrl = await $.env.get('CLM_BASE_URL').catch(() => undefined)
    const s = await update($, settings, () => {
      const stand = { ...DEFAULTS, ...(stored ?? {}) }
      const merged = envUrl !== undefined && /^https?:\/\//i.test(envUrl) && stand.url === DEFAULT_URL ? { ...stand, url: envUrl } : stand
      // A stored value from before encoderArgs existed, or a hand-edited one, falls back to the default.
      const encoderArgs = typeof merged.encoderArgs === 'string' ? merged.encoderArgs : DEFAULT_ENCODER_ARGS
      // Settings stored before the mod spoke English came from its Italian-only version.
      const chosen: unknown = stored !== undefined && stored.lang === undefined ? 'it' : merged.lang
      const resolved: ClmSettings['lang'] = chosen === 'en' || chosen === 'it' ? chosen : 'auto'

      return { ...merged, encoderArgs, lang: resolved }
    })

    if (stored !== undefined && stored.lang === undefined) await $.store.set('settings', s)

    loadEpoch = await $.clock.now()

    // Resolved before anything is drawn or registered, so the first draw is already in the person's
    // language (auto costs a settings read, a few variables and, on Windows, one registry query).
    await applyLang($, s).catch(() => undefined)

    const tr = await words($)

    await $.command.register({
      name: 'clm',
      description: tr.commandDescription,
      argumentHint: '[on|off|status|menu|log|test|help]',
      immediate: true,
    })
    await $.tool.register({
      name: 'rank',
      description: RANK_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          context: { type: 'string', description: 'The situation the candidates answer: task, state, or question.' },
          candidates: {
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
            maxItems: 64,
            description: 'The options to rank, each a self-contained text.',
          },
          question: { type: 'string', description: 'Optional: what "best" means, appended to the context.' },
        },
        required: ['context', 'candidates'],
      },
    })
    await $.tool.register({
      name: 'ask',
      description: ASK_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          state: { type: 'string', description: 'The text the questions are about.' },
          questions: {
            type: 'object',
            description: 'Map of question id to {type, instructions, criteria?}.',
            additionalProperties: { type: 'object' },
          },
        },
        required: ['state', 'questions'],
      },
    })

    await syncStatus($)

    if (s.enabled) {
      void ping($)
    }

    // Every 5 s while CLM is on and not ready, so the dot turns green as soon as the servers
    // answer; once it is green, a check a minute is enough to notice them going away.
    $.clock.every(5_000, () => {
      void (async () => {
        const current = await read($, settings)

        if (!current.enabled) return

        const probe = await read($, health)

        if (probe === null || !probe.ok || (await $.clock.now()) - probe.at >= 60_000) {
          await ping($)
        }
      })().catch(() => undefined)
    })

    return next(e)
  })

  // Switched off, the tools wait behind ToolSearch and say so, so they cost the prompt nothing.
  const hidden = { description: 'CLM-8B is switched off (/clm on). Do not call.', isDeferred: true } as const

  on('tool.describe', { tool: 'mcp__clm__rank' }, async ($, e, next) =>
    (await read($, settings)).enabled ? { ...(await next(e)), isDeferred: false } : hidden,
  )
  on('tool.describe', { tool: 'mcp__clm__ask' }, async ($, e, next) =>
    (await read($, settings)).enabled ? { ...(await next(e)), isDeferred: false } : hidden,
  )

  on('tool.call', { tool: RANK_TOOL }, async ($, e) => {
    const s = await read($, settings)

    if (!s.enabled) return { deny: OFF_REASON }

    const input = e as unknown as { context?: unknown; candidates?: unknown; question?: unknown }
    const candidates = Array.isArray(input.candidates) ? input.candidates.map(String).filter(c => c.trim() !== '') : []

    if (typeof input.context !== 'string' || candidates.length < 2) {
      return { deny: 'rank needs a context string and at least two non-empty candidates.' }
    }

    try {
      const question = typeof input.question === 'string' ? input.question : ''
      const { ranked, call, notes } = await rank($, s, 'tool', input.context, candidates, question, TOOL_TIMEOUT_MS)
      const lines = ranked.map((r, place) => `${place + 1}. ${pct(r.prob)}  #${r.index + 1}  ${oneLine(r.candidate, 200)}`)
      const cut = notes.length > 0 ? `\n(${notes.join('; ')})` : ''

      return { result: `CLM-8B ranking (${ms(call)}), best first; #n is the candidate's number in your list:\n${lines.join('\n')}${cut}` }
    } catch (error) {
      await failed($, 'tool', 'rank', oneLine(input.context, 120), error)

      // The model is told in English, whatever language the person reads the log in.
      return { deny: `CLM-8B did not answer: ${describeError(error, STRINGS.en)}. Carry on without it.` }
    }
  }).catch(() => ({ deny: 'CLM-8B failed inside the mod. Carry on without it.' }))

  on('tool.call', { tool: ASK_TOOL }, async ($, e) => {
    const s = await read($, settings)

    if (!s.enabled) return { deny: OFF_REASON }

    const input = e as unknown as { state?: unknown; questions?: unknown }
    const questions = input.questions

    if (typeof input.state !== 'string' || questions === null || typeof questions !== 'object' || Array.isArray(questions)) {
      return { deny: 'ask needs a state string and a questions object.' }
    }

    try {
      const { answers, call, isCut } = await ask($, s, 'tool', input.state, questions as Record<string, unknown>, { timeoutMs: TOOL_TIMEOUT_MS })
      const cut = isCut ? '\n(state cut: CLM read only its last part)' : ''

      return { result: `CLM-8B answers (${ms(call)}):\n${JSON.stringify(answers, null, 2)}${cut}` }
    } catch (error) {
      await failed($, 'tool', 'systemone', oneLine(input.state, 120), error)

      return { deny: `CLM-8B did not answer: ${describeError(error, STRINGS.en)}. Carry on without it.` }
    }
  }).catch(() => ({ deny: 'CLM-8B failed inside the mod. Carry on without it.' }))

  // Guard: hooked on the permission decision itself, after the rules, the mode and the settings'
  // PreToolUse hooks have spoken, so it scores the command as it will run, and only when the
  // verdict is "ask". Advisory only: the verdict passes on unchanged, whatever CLM says.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await next(e)

    // A query ($.tool.check, no tool_use_id) has no dialog to annotate.
    if (verdict.decision !== 'ask' || e.tool_use_id === undefined) return verdict

    const s = await read($, settings)

    if (!s.enabled || !s.guard || !(await hooksMayCall($))) return verdict

    const input = (e.input ?? {}) as { command?: unknown }
    const command = String(input.command ?? '').trim()

    if (command === '') return verdict

    const tr = await words($)
    // The command alone, never the agent's own description of it, which could talk the score down;
    // both ends of a long one, where a destructive verb and its target sit.
    const shown = command.length > 1500 ? `${command.slice(0, 1000)}\n…\n${command.slice(-450)}` : command
    const answered = await throughBreaker($, 'guard', oneLine(command, 120), () =>
      ask(
        $,
        s,
        'guard',
        `Shell command an AI coding agent is about to run:\n$ ${shown}`,
        {
          risk: {
            type: 'choice',
            instructions: 'What will running this command do?',
            criteria: {
              safe: 'Reads files, builds, runs tests, or makes small, easily reversible changes in the project',
              destructive:
                'Deletes or overwrites files or data, rewrites git history, force-pushes, drops databases, or changes system settings',
              exfiltration:
                'Sends files or data off the machine, downloads and runs code, reads credentials, keys or secrets, or changes permissions',
            },
          },
        },
        {
          timeoutMs: Math.min(s.timeoutMs, GUARD_TIMEOUT_MS),
          subject: `$ ${command}`,
          headline: answers => {
            const safe = answers.risk?.probabilities?.safe

            return typeof safe === 'number'
              ? { label: 'risk', p: 1 - safe, tone: toneOf(1 - safe, s.guardThreshold), verdict: answers.risk?.choice ?? '' }
              : undefined
          },
        },
      ),
    )
    const safe = answered?.answers.risk?.probabilities?.safe

    if (answered === undefined || typeof safe !== 'number') return verdict

    const risk = 1 - safe

    try {
      $.ui.notice(e.tool_use_id, tr.guardNotice(pct(risk), fmtMs(answered.call.clientMs)))
    } catch {
      // No dialog open for this call (auto mode decides with its classifier): the log keeps it.
    }

    if (risk >= s.guardThreshold) {
      $.ui.toast(tr.guardToast(pct(risk)))
    }

    return verdict
  }).catch(($, e, next) => next(e)) // replay-safe: the verdict already reached stands

  // Check: after a Bash call the engine did not report as an error, an output that reads like a
  // failure gets a hidden note to the model. Main thread and subagents alike pass here.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const s = await read($, settings)

    if (!s.enabled || !s.check) return next(e)

    const ran = await next(e)

    // Everything after `next` is wrapped: the command has run, and must never run again.
    try {
      const command = String(e.command ?? '')
      const r = (ran.result ?? {}) as { stdout?: unknown; stderr?: unknown; backgroundTaskId?: unknown; returnCodeInterpretation?: unknown }
      // A background start, or a nonzero exit the tool already explained (grep 1, diff 1): nothing silent.
      const isExplained = r.backgroundTaskId !== undefined || r.returnCodeInterpretation !== undefined
      const output =
        typeof r.stdout === 'string' ? `${r.stdout}\n${typeof r.stderr === 'string' ? r.stderr : ''}`.trim() : (ran.text ?? '').trim()

      if (
        ran.deny !== undefined ||
        ran.isError === true ||
        ran.isReadOnly === true ||
        isExplained ||
        output.length < 20 ||
        !FAILURE_CUE.test(output) ||
        isPlainRead(command) ||
        !(await hooksMayCall($))
      ) {
        return ran
      }

      const tr = await words($)
      // Failure summaries come at the end of an output: its tail, after the command's head, the two
      // within CHECK_STATE_CHARS (tail adds one "…").
      const shownCommand = `$ ${head(command, 200)}`
      const answered = await throughBreaker($, 'check', oneLine(command, 120), () =>
        ask(
          $,
          s,
          'check',
          `${shownCommand}\n${tail(output, CHECK_STATE_CHARS - shownCommand.length - 2)}`,
          {
            outcome: {
              type: 'choice',
              instructions: 'Did this shell command succeed?',
              criteria: {
                success: 'The command succeeded: normal output, tests passed, the build completed',
                failure: 'The command failed: errors, exceptions, stack traces, failing tests, or a build that did not succeed',
              },
            },
          },
          {
            timeoutMs: Math.min(s.timeoutMs, CHECK_TIMEOUT_MS),
            subject: `$ ${command}`,
            headline: answers => {
              const p = answers.outcome?.probabilities?.failure

              return typeof p === 'number'
                ? { label: 'failure', p, tone: toneOf(p, s.checkThreshold), verdict: answers.outcome?.choice ?? '' }
                : undefined
            },
          },
        ),
      )
      const failure = answered?.answers.outcome?.probabilities?.failure

      if (answered === undefined || typeof failure !== 'number' || failure < s.checkThreshold) return ran

      await update($, calls, list => list.map(c => (c.id === answered.call.id ? { ...c, flagged: true } : c)))

      const note =
        `[CLM-8B verifier] \`${oneLine(command, 80)}\` was not reported as an error, but a CLM-8B estimate ` +
        `(p=${failure.toFixed(2)}) says its output reads like a failure. Re-read the output before relying on it.`

      return { ...ran, context: [...(ran.context ?? []), note] }
    } catch {
      return ran
    }
    // Only a fault before `next` reaches this (everything after it is caught above), so the command
    // never runs twice; a fault in the mod never stands between the agent and Bash.
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'clm' }, async ($, e) => {
    const args = e.args.trim()
    const [rawVerb = '', rawArg = ''] = args.split(/\s+/)
    const verb = ALIASES[rawVerb.toLowerCase()] ?? rawVerb.toLowerCase()
    const arg = rawArg.toLowerCase()
    // A path or a URL is the whole rest of the line (it may hold spaces), as typed, without surrounding quotes.
    const rest = args.slice(rawVerb.length).trim().replace(/^"(.*)"$/, '$1')
    const s = await read($, settings)
    const tr = await words($)

    switch (verb) {
      case 'menu': {
        await openMenu($)

        return { text: tr.menuOpened }
      }
      case 'restart':
        return { text: await serviceAction($, 'restart') }
      case 'stop':
        return { text: await serviceAction($, 'stop') }
      case 'services': {
        await refreshServices($)
        const svc = await read($, services)
        const plan = await planServices($, s)
        const proc = (p: ClmServices['encoder']) => (p === null ? tr.stopped : `${p.name} (PID ${p.pid})`)

        return {
          text: [
            `${tr.svcEncoder.padEnd(10)} ${tr.svcPort} ${plan.encoderPort}: ${proc(svc?.encoder ?? null)}`,
            `${tr.svcServe.padEnd(10)} ${tr.svcPort} ${plan.clmPort}: ${proc(svc?.serve ?? null)}`,
            `${tr.svcLlama}: ${plan.encoderBin ?? tr.notFound}`,
            `${tr.svcModel}: ${plan.encoderModel}`,
            `${tr.svcArgs}: ${plan.encoderArgs === '' ? tr.none : plan.encoderArgs}`,
            `${tr.svcServe}: ${plan.clmServeBin ?? tr.notFound}`,
            `${tr.svcLogs}: ${plan.logDir}`,
            ...(plan.problems.length > 0 ? ['', tr.svcToFix, ...plan.problems.map(tr.problem)] : []),
          ].join('\n'),
        }
      }
      case 'encoder':
      case 'llama':
      case 'serve': {
        const isDefault = rest === '' || rest.toLowerCase() === 'default'

        if (!isDefault && /["%&|<>^'\r\n]/.test(rest)) return { text: tr.badPathChars }
        if (!isDefault && verb === 'encoder' && !/\.gguf$/i.test(rest)) return { text: tr.notGguf }
        if (!isDefault && !(await $.fs.exists(rest))) return { text: tr.fileNotFound(rest) }

        const value = isDefault ? null : rest

        await saveSettings($, verb === 'encoder' ? { encoderModel: value } : verb === 'llama' ? { encoderBin: value } : { clmServeBin: value })
        const plan = await planServices($, await read($, settings))
        const resolved = verb === 'encoder' ? plan.encoderModel : verb === 'llama' ? plan.encoderBin : plan.clmServeBin

        return { text: tr.pathSet(verb, resolved ?? tr.notFound) }
      }
      case 'encoder-args': {
        // The options are the whole rest of the line, as typed; "default" restores the mod's own.
        if (rest === '') return { text: tr.encoderArgsIs(s.encoderArgs) }

        const options = rest.toLowerCase() === 'default' ? DEFAULT_ENCODER_ARGS : rest.replace(/\s+/g, ' ')
        const problem = encoderArgsProblem(options)

        if (problem !== null) return { text: tr.problem({ kind: 'bad-args', reason: problem }) }

        await saveSettings($, { encoderArgs: options })

        return { text: tr.encoderArgsSet(options) }
      }
      case 'tag': {
        if (arg !== 'auto' && arg !== 'button') return { text: tr.usage('tag auto|button') }
        await saveSettings($, { tagStyle: arg })
        isClientRefused = false
        isGraceArmed = false
        $.ui.invalidate('ui.render')

        return { text: arg === 'auto' ? tr.tagAuto : tr.tagButton }
      }
      case 'lang': {
        if (arg !== 'auto' && arg !== 'en' && arg !== 'it') return { text: tr.usage('lang auto|en|it') }

        const resolved = await applyLang($, await saveSettings($, { lang: arg }))

        return { text: STRINGS[resolved].langSet(arg) }
      }
      case 'on': {
        const probe = (await setEnabled($, true)) as ClmHealth

        return { text: probe.ok ? tr.onReady(probe.detail, s.band) : tr.onOffline(probe.detail, s.url) }
      }
      case 'off': {
        await setEnabled($, false)

        return { text: tr.offDone }
      }
      case 'guard':
      case 'check': {
        const threshold = parseThreshold(arg)

        if (arg !== 'on' && arg !== 'off' && threshold === null) return { text: tr.usage(`${verb} on|off|<1-99>`) }

        const change: Partial<ClmSettings> =
          threshold !== null
            ? verb === 'guard'
              ? { guardThreshold: threshold }
              : { checkThreshold: threshold }
            : verb === 'guard'
              ? { guard: arg === 'on' }
              : { check: arg === 'on' }
        const next = await saveSettings($, change)
        const said = threshold === null ? '' : `${tr.thresholdSet(verb, pct(threshold))}\n\n`

        return { text: `${said}${statusMarkdown(next, await read($, health), tr)}` }
      }
      case 'band': {
        if (arg !== 'on' && arg !== 'off') return { text: tr.usage('band on|off') }

        return { text: statusMarkdown(await saveSettings($, { band: arg === 'on' }), await read($, health), tr) }
      }
      case 'url': {
        if (!/^https?:\/\/\S+$/i.test(rest)) return { text: tr.usage(`url ${DEFAULT_URL}`) }
        const next = await saveSettings($, { url: rest })

        if (!next.enabled) return { text: tr.urlLater(rest) }

        const probe = await ping($)

        return { text: tr.urlSet(rest, probe.ok ? tr.reachable : probe.detail) }
      }
      case 'model': {
        const known = (await read($, health))?.models ?? []

        if (rest === '') return { text: tr.modelIs(s.model, known) }

        const value = rest.toLowerCase() === 'default' ? null : rest

        if (value !== null && known.length > 0 && !known.includes(value)) return { text: tr.modelUnknown(value, known) }

        await saveSettings($, { model: value })

        return { text: tr.modelSet(value) }
      }
      case 'log': {
        const opened = await openLog($).catch((error: unknown) => ({ isPlaced: false as const, reason: String(error) }))

        if (opened.isPlaced) return { text: tr.logOpened }

        // Where no pane can be placed, the log is the command's own output.
        const list = await read($, calls)
        const lines = list.slice(0, 10).map(c => `${clock(c.at)} ${c.source} ${c.ok ? ms(c) : tr.error} — ${c.answer}`)

        return { text: [tr.logFallback(opened.reason ?? '?'), ...(lines.length > 0 ? lines : [tr.none])].join('\n') }
      }
      case 'clear': {
        await update($, calls, () => [])
        await syncStatus($)

        return { text: tr.cleared }
      }
      case 'test': {
        if (!s.enabled) return { text: tr.testOff }

        try {
          const { call } = await quickTest($, s)

          return { text: `${tr.testResult(call.answer, ms(call))}\n${call.detail.join('\n')}` }
        } catch (error) {
          const call = await failed($, 'test', 'rank', 'test', error)

          return { text: tr.testFailed(call.error ?? '') }
        }
      }
      case 'help':
        return { text: helpMarkdown(tr) }
      case '':
      case 'status':
        // Off means no CLM call of any kind: the last known health, not a new probe.
        return { text: statusMarkdown(s, s.enabled ? await ping($) : await read($, health), tr) }
      default:
        return { text: `${tr.unknownVerb(rawVerb)}\n\n${helpMarkdown(tr)}` }
    }
  })

  // The tag in the prompt footer, beside the model: a dot (grey off, yellow checking, green ready,
  // red offline) and a button that switches CLM on and off. What lies beneath (the engine's own mode
  // labels, another plugin's tag) is drawn first, through next(e), awaited once; then a gap and our dot.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const inner = await next(e)
    const s = await read($, settings)
    const probe = await read($, health)
    const tr = STRINGS[await read($, lang)]
    const last = s.enabled ? (await read($, calls))[0] : undefined
    const light = lamp(s, probe, tr)
    const label = probe?.ok === true && last?.ok ? `${light.label} · ${fmtMs(last.clientMs)}` : light.label

    if (!isFooterDrawn) {
      isFooterDrawn = true
      // The footer now carries the tag: take the plain-text stand-in down, after this draw.
      $.clock.after(0, () => void syncStatus($).catch(() => undefined))
    }

    // A Client takes the right click; only terminal and desktop draw one, and an older desktop may
    // not: no "mounted" from it within the grace period and the tag falls back to a Button.
    if ((e.surface === 'terminal' || e.surface === 'desktop') && s.tagStyle === 'auto' && !isClientRefused) {
      if (!isClientConfirmed && !isGraceArmed) {
        isGraceArmed = true
        $.clock.after(CLIENT_GRACE_MS, () => {
          if (isClientConfirmed) return
          isClientRefused = true
          $.ui.invalidate('ui.render')
        })
      }

      const { Box, Client, Text } = $.ui.resolve(e)
      const tag: TagProps = { glyph: light.glyph, color: light.color, label, isDim: !s.enabled, epoch: loadEpoch }

      return (
        <Box key="clm-tag" flexDirection="row">
          {inner}
          <Text> </Text>
          <Client key={TAG_CLIENT} module="./tag.tsx" props={tag} />
        </Box>
      )
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box key="clm-tag" flexDirection="row">
        {inner}
        <Text> </Text>
        {light.color === null ? (
          <Text dimColor>
            {light.glyph}{' '}
          </Text>
        ) : (
          <Text color={light.color} bold>
            {light.glyph}{' '}
          </Text>
        )}
        <Button
          key="toggle"
          label={label}
          plain
          dimColor={!s.enabled}
          onPress={() => {
            // Read now, not at draw time: two clicks before a redraw still alternate.
            void read($, settings).then(current => setEnabled($, !current.enabled))
          }}
        />
      </Box>
    )
  }).catch(($, e, next) => next(e)) // a fault here leaves what lies beneath: the engine's own labels and other plugins' tags

  // The tag's Client: "mounted" proves the surface draws it; a left click switches, a right one
  // opens the menu.
  on('ui.message', async ($, e, next) => {
    if (e.element !== TAG_CLIENT) return next(e)

    const { type } = (e.data ?? {}) as { type?: unknown }

    if (type === 'mounted') {
      isClientConfirmed = true
    } else if (type === 'toggle') {
      await setEnabled($, !(await read($, settings)).enabled)
    } else if (type === 'menu') {
      await openMenu($)
    }

    return {}
  })

  // The context menu: a small dialog pane (arrows, 1-9 or a letter, Esc closes) with the services
  // up top, the actions, then the switches, each with its state and threshold.
  on('ui.render', { component: 'Pane', requestId: MENU }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const s = await read($, settings)
    const probe = await read($, health)
    const svc = await read($, services)
    const tr = STRINGS[await read($, lang)]
    const light = lamp(s, probe, tr)
    const width = Math.max(20, e.props.bodyColumns - 2)
    const isBusy = typeof svc?.busy === 'string'
    const heads = [null, ...(probe?.models ?? [])]
    // Every press reads the settings anew: a value captured at draw time can be stale by then.
    const flip = (key: 'guard' | 'check' | 'band') => () => {
      void read($, settings).then(current =>
        saveSettings($, key === 'guard' ? { guard: !current.guard } : key === 'check' ? { check: !current.check } : { band: !current.band }),
      )
    }
    const service = (name: string, port: number, p: ClmServices['encoder']) => (
      <Box flexDirection="row">
        {svc === null ? <Text dimColor>◌ </Text> : p === null ? <Text color="error">● </Text> : <Text color="success">● </Text>}
        <Text bold>{name.padEnd(10)}</Text>
        <Text dimColor>:{String(port).padEnd(6)}</Text>
        <Text dimColor wrap="truncate-end">
          {svc === null ? tr.notChecked : p === null ? tr.stopped : `${p.name} · PID ${p.pid}`}
        </Text>
      </Box>
    )
    const state = (isOn: boolean) => (isOn ? <Text color="success">● ON </Text> : <Text dimColor>○ OFF</Text>)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          {light.color === null ? (
            <Text dimColor>{light.glyph} </Text>
          ) : (
            <Text color={light.color} bold>
              {light.glyph}{' '}
            </Text>
          )}
          <Text bold>{light.label}</Text>
          <Text dimColor wrap="truncate-end">
            {'  ·  '}
            {tr.head} {s.model ?? tr.defaultHead}
          </Text>
        </Box>
        <Text> </Text>
        <Text dimColor bold>
          {tr.sectionServices}
        </Text>
        {service('encoder', s.encoderPort, svc?.encoder ?? null)}
        {service('clm-serve', portOf(s.url).port, svc?.serve ?? null)}
        {isBusy && <Text color="warning">{svc?.busy}</Text>}
        {(svc?.lines ?? []).slice(0, 6).map(line => (
          <Text dimColor wrap="truncate-end">
            {oneLine(line, width)}
          </Text>
        ))}
        <Text> </Text>
        <Button
          key="m-toggle"
          hotkey="1"
          plain
          autoFocus
          variant="primary"
          label={s.enabled ? tr.menuTurnOff : tr.menuTurnOn}
          onPress={() => {
            void read($, settings).then(current => setEnabled($, !current.enabled))
          }}
        />
        <Button key="m-restart" hotkey="2" plain label={tr.menuRestart} onPress={() => void serviceAction($, 'restart')} />
        <Button key="m-stop" hotkey="3" plain label={tr.menuStop} onPress={() => void serviceAction($, 'stop')} />
        <Button key="m-refresh" hotkey="4" plain label={tr.menuRefresh} onPress={() => void refreshServices($).catch(() => undefined)} />
        <Button
          key="m-log"
          hotkey="5"
          plain
          label={tr.menuLog}
          onPress={() => {
            void $.ui
              .close({ id: MENU })
              .then(() => openLog($))
              .catch(() => undefined)
          }}
        />
        <Button
          key="m-test"
          hotkey="6"
          plain
          label={tr.menuTest}
          onPress={() => {
            void read($, settings)
              .then(current =>
                current.enabled
                  ? quickTest($, current).then(({ call }) => $.ui.toast(tr.testResult(call.answer, ms(call))))
                  : $.ui.toast(tr.testOffToast),
              )
              .catch(error => $.ui.toast(tr.testFailed(describeError(error, tr))))
          }}
        />
        <Text> </Text>
        <Text dimColor bold>
          {tr.sectionFeatures}
        </Text>
        <Button key="m-guard" hotkey="7" plain onPress={flip('guard')}>
          {state(s.guard)} Guard <Text dimColor>· {tr.guardHint} · ≥ {pct(s.guardThreshold)}</Text>
        </Button>
        <Button key="m-check" hotkey="8" plain onPress={flip('check')}>
          {state(s.check)} Check <Text dimColor>· {tr.checkHint} · ≥ {pct(s.checkThreshold)}</Text>
        </Button>
        <Button key="m-band" hotkey="9" plain onPress={flip('band')}>
          {state(s.band)} Band <Text dimColor>· {tr.bandHint}</Text>
        </Button>
        <Button
          key="m-head"
          hotkey="h"
          plain
          onPress={() => {
            // The next head the server lists, back to its default after the last.
            void read($, settings).then(current => saveSettings($, { model: heads[(heads.indexOf(current.model) + 1) % heads.length] ?? null }))
          }}
        >
          {tr.menuHead} <Text color="suggestion">{s.model ?? tr.defaultHead}</Text>
          {heads.length > 1 ? <Text dimColor> ⇄</Text> : ''}
        </Button>
        <Button
          key="m-lang"
          hotkey="l"
          plain
          onPress={() => {
            void read($, lang).then(current => saveSettings($, { lang: current === 'it' ? 'en' : 'it' }).then(next => applyLang($, next)))
          }}
        >
          {tr.menuLang} <Text color="suggestion">{tr.langName}</Text>
          <Text dimColor> ⇄</Text>
        </Button>
        <Text> </Text>
        <Button key="m-close" role="dismiss" plain label={tr.menuClose} onPress={() => void $.ui.close({ id: MENU }).catch(() => undefined)} />
      </Box>
    )
  })

  // Above the prompt, while CLM is on: where the last answer came from, what it was about, then
  // the one number it is about as a bar with CLM's pick beside it, how long it took, and the log.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, settings)
    const last = s.enabled && s.band && !e.props.hasSurvey ? (await read($, calls))[0] : undefined

    if (last === undefined) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const tr = STRINGS[await read($, lang)]
    const top = last.ok ? last.headline : undefined
    const meter = top === undefined ? null : bar(top.p, 8)
    const verdict = top === undefined ? '' : verdictOf(top, tr)

    return (
      <Box flexDirection="row">
        <Text color="magenta" bold>
          ◆ CLM-8B{' '}
        </Text>
        <Text color={SOURCE_COLOR[last.source]} bold>
          {tr.sourceBadge[last.source].trim()}{' '}
        </Text>
        <Box flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {oneLine(last.subject, 48)}
          </Text>
        </Box>
        <Text dimColor> → </Text>
        {!last.ok ? (
          <Box flexShrink={1}>
            <Text color="error" wrap="truncate-end">
              ✗ {last.error ?? last.answer}
            </Text>
          </Box>
        ) : meter !== null && top !== undefined ? (
          <Box flexDirection="row" flexShrink={1}>
            <Text>{tr.term[top.label] ?? top.label} </Text>
            <Text mono color={TONE_COLOR[top.tone]}>
              {meter.filled}
            </Text>
            <Text mono dimColor>
              {meter.track}
            </Text>
            <Text color={TONE_COLOR[top.tone]} bold>
              {' '}
              {pct(top.p)}
            </Text>
            {/* A flagged check says so in place of its pick, which would only repeat "failure". */}
            {last.flagged === true ? (
              <Text color="warning"> · ⚑ {tr.flagged}</Text>
            ) : (
              verdict !== '' && (
                <Box flexShrink={1}>
                  <Text wrap="truncate-end"> · {verdict}</Text>
                </Box>
              )
            )}
          </Box>
        ) : (
          <Box flexShrink={1}>
            <Text wrap="truncate-end">{last.answer}</Text>
          </Box>
        )}
        <Text dimColor>
          {'  '}
          {last.ok ? fmtMs(last.clientMs) : ''}
          {'  '}
        </Text>
        <Button
          key="log"
          label="log"
          plain
          dimColor
          onPress={() => {
            void openLog($)
              .then(opened => {
                if (!opened.isPlaced) $.ui.toast(tr.logUnavailable)
              })
              .catch(() => undefined)
          }}
        />
      </Box>
    )
  })

  // The log. Up top: the state in a word, with the way out when it is not ready (turn on, restart);
  // the head and the endpoint; a summary in small type (calls, p50, p95, errors, flags) and the
  // latencies, a sparkline on the terminal and a chart elsewhere; a filter per source the log holds.
  // Then each call: when, where from, what about and how long; the one number it is about, with
  // CLM's pick; ▸ opens the whole distribution. Where the surface draws Svg, bars are pills.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    // Decided by the surface, not the table: the terminal's table answers Svg too, drawing an empty box.
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : null
    const s = await read($, settings)
    const probe = await read($, health)
    const svc = await read($, services)
    const all = await read($, calls)
    const shown = await read($, filter)
    const open = await read($, selected)
    const tr = STRINGS[await read($, lang)]
    const term = (key: string) => tr.term[key] ?? key
    const width = Math.max(24, (e.props.bodyColumns ?? 80) - 2)
    const list = shown === 'all' ? all : all.filter(c => c.source === shown)
    const latencies = list.filter(c => c.ok).map(c => c.clientMs)
    const errors = list.filter(c => !c.ok).length
    const flagged = list.filter(c => c.flagged === true).length
    const count = (f: ClmFilter) => (f === 'all' ? all.length : all.filter(c => c.source === f).length)
    const light = lamp(s, probe, tr)
    const state = !s.enabled
      ? tr.status.off
      : probe === null
        ? tr.status.checking
        : !probe.ok
          ? tr.status.offline
          : probe.isMock === true
            ? tr.status.mock
            : tr.status.ready
    const isBusy = typeof svc?.busy === 'string'
    // Rows for the calls: the viewport less the header, the summary, the chart and the filters.
    const room = Math.max(6, (e.viewport?.rows ?? 30) - (Svg === null ? 6 : 10))

    /** A meter: a pill where the surface draws Svg, else a bar of blocks on a thin track. */
    const meter = (p: number, cells: number, color: string, hex: string) =>
      Svg === null ? (
        <Box flexDirection="row">
          <Text color={color}>{bar(p, cells).filled}</Text>
          <Text dimColor>{bar(p, cells).track}</Text>
        </Box>
      ) : (
        <Svg source={meterSvg(p, cells * 7, 6, hex)} alt={pct(p)} width={cells * 7} height={6} />
      )

    const rows: JSX.Element[] = []
    let used = 0

    for (const call of list) {
      if (used >= room) break

      const hasDetail = call.ok && (call.dist?.length ?? 0) > 0
      const isOpen = hasDetail && call.id === open
      const top = call.ok ? call.headline : undefined
      const verdict = top === undefined ? '' : verdictOf(top, tr)
      const lines: JSX.Element[] = [
        <Box flexDirection="row" alignItems="center">
          <Button key={`c-${call.id}`} plain onPress={() => void update($, selected, current => (current === call.id ? null : call.id))}>
            <Text dimColor>{hasDetail ? (isOpen ? '▾ ' : '▸ ') : '  '}</Text>
            <Text size="footnote" tabular dimColor>
              {clock(call.at)}{' '}
            </Text>
            <Text size="caption" weight="semibold" color={SOURCE_COLOR[call.source]}>
              {tr.sourceBadge[call.source]}
            </Text>
          </Button>
          <Box flexGrow={1} flexShrink={1} paddingLeft={1}>
            <Text wrap="truncate-end">{oneLine(call.subject, 160)}</Text>
          </Box>
          <Text size="footnote" tabular dimColor>
            {' '}
            {call.ok ? fmtMs(call.clientMs) : ''}
          </Text>
        </Box>,
        <Box flexDirection="row" alignItems="center" paddingLeft={INDENT}>
          {!call.ok ? (
            <Box flexShrink={1}>
              <Text size="footnote" color="error" wrap="truncate-end">
                {call.error ?? call.answer}
              </Text>
            </Box>
          ) : top !== undefined ? (
            <Box flexDirection="row" alignItems="center" flexShrink={1}>
              <Text size="footnote" dimColor>
                {term(top.label)}{' '}
              </Text>
              {meter(top.p, 10, TONE_COLOR[top.tone], TONE_HEX[top.tone])}
              <Text size="footnote" tabular weight="semibold" color={TONE_COLOR[top.tone]}>
                {pct(top.p).padStart(7)}
              </Text>
              {verdict !== '' && (
                <Box flexShrink={1}>
                  <Text size="footnote" wrap="truncate-end">
                    {' · '}
                    {verdict}
                  </Text>
                </Box>
              )}
            </Box>
          ) : (
            <Box flexShrink={1}>
              <Text size="footnote" wrap="truncate-end">
                {call.answer}
              </Text>
            </Box>
          )}
          {/* The flag alone: the summary above says what it means. */}
          {call.flagged === true && <Text color="warning"> ⚑</Text>}
        </Box>,
      ]

      if (isOpen) {
        // The whole distribution, one meter per option, the likeliest of each question in the accent.
        const options = (call.dist ?? []).slice(0, 8)
        const labels = options.map(o => oneLine(o.group === undefined ? term(o.label) : `${o.group} · ${term(o.label)}`, 28))
        const labelWidth = Math.max(4, ...labels.map(l => l.length)) + 1
        const cells = Math.max(6, Math.min(24, width - INDENT - labelWidth - 8))
        const bestOf = (group: string | undefined) => Math.max(...options.filter(o => o.group === group).map(o => o.p))
        const timing = [call.serverMs === null ? '' : `server ${fmtMs(call.serverMs)}`, call.tokens === null ? '' : `${call.tokens} tok`].filter(t => t !== '')

        options.forEach((option, place) => {
          const isBest = option.p === bestOf(option.group)

          lines.push(
            <Box flexDirection="row" alignItems="center" paddingLeft={INDENT}>
              <Box width={labelWidth} flexShrink={0}>
                <Text size="footnote" dimColor={!isBest} wrap="truncate-end">
                  {labels[place] ?? ''}
                </Text>
              </Box>
              {meter(option.p, cells, isBest ? 'suggestion' : 'subtle', isBest ? TONE_HEX.neutral : MUTED_HEX)}
              <Text size="footnote" tabular weight={isBest ? 'semibold' : 'regular'} dimColor={!isBest}>
                {pct(option.p).padStart(7)}
              </Text>
            </Box>,
          )
        })

        if (timing.length > 0) {
          lines.push(
            <Box paddingLeft={INDENT}>
              <Text size="footnote" dimColor>
                {timing.join(' · ')}
              </Text>
            </Box>,
          )
        }
      }

      used += lines.length
      rows.push(<Box flexDirection="column">{lines}</Box>)
    }

    // Only the sources the log holds, and the one shown.
    const filters = (['all', 'tool', 'guard', 'check', 'test'] as ClmFilter[]).filter(f => f === 'all' || f === shown || count(f) > 0)
    const p50 = fmtMs(percentile(latencies, 0.5))
    const p95 = fmtMs(percentile(latencies, 0.95))
    const spark = Svg === null && latencies.length > 1 ? sparkline([...latencies].reverse(), Math.max(8, Math.min(24, width - 48))) : ''
    let chart: JSX.Element | null = null

    if (Svg !== null && latencies.length > 1) {
      const points = list.slice(0, MAX_LOG).reverse()
      // About a cell's width in pixels per column, so the chart fits the pane it is drawn in.
      const chartWidth = Math.round(Math.max(320, Math.min(720, width * 7)))

      chart = <Svg source={latencyChart(points, chartWidth, 56)} alt={tr.chartAlt(points.length, p50, p95)} height={56} />
    }

    // What the header offers when CLM is not ready: the way out, not just the news.
    const action = !s.enabled ? (
      <Button key="h-on" label={tr.menuTurnOn} variant="primary" onPress={() => void setEnabled($, true)} />
    ) : probe !== null && !probe.ok && !isBusy ? (
      <Button key="h-restart" label={tr.restartShort} variant="primary" onPress={() => void serviceAction($, 'restart')} />
    ) : null

    return (
      <Box flexDirection="column" rowGap="sm">
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" justifyContent="space-between">
            <Box flexDirection="row" alignItems="center">
              {light.color === null ? (
                <Text dimColor>{light.glyph} </Text>
              ) : (
                <Text color={light.color}>{light.glyph} </Text>
              )}
              <Text weight="semibold">{state}</Text>
            </Box>
            {action}
          </Box>
          <Text size="footnote" dimColor wrap="truncate-end">
            CLM-8B · {s.model ?? probe?.models?.[0] ?? tr.defaultHead} · {s.url.replace(/^https?:\/\//, '')}
          </Text>
          {probe !== null && !probe.ok && !isBusy && (
            <Text size="footnote" color="error" wrap="truncate-end">
              {probe.detail}
            </Text>
          )}
          {isBusy && (
            <Text size="footnote" color="warning">
              {svc?.busy}
            </Text>
          )}
          {/* What the last restart from here said, while CLM is still not ready. */}
          {!isBusy &&
            probe?.ok !== true &&
            (svc?.lines ?? []).slice(0, 3).map(line => (
              <Text size="footnote" dimColor wrap="truncate-end">
                {line}
              </Text>
            ))}
        </Box>
        {all.length > 0 && (
          <Box flexDirection="column">
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              <Box flexDirection="row">
                <Text size="footnote" tabular>
                  {list.length}{' '}
                </Text>
                <Text size="footnote" dimColor>
                  {tr.callsWord(list.length)}
                </Text>
              </Box>
              {latencies.length > 0 && (
                <Box flexDirection="row">
                  <Text size="footnote" dimColor>
                    p50{' '}
                  </Text>
                  <Text size="footnote" tabular>
                    {p50}
                  </Text>
                </Box>
              )}
              {latencies.length > 0 && (
                <Box flexDirection="row">
                  <Text size="footnote" dimColor>
                    p95{' '}
                  </Text>
                  <Text size="footnote" tabular>
                    {p95}
                  </Text>
                </Box>
              )}
              {errors > 0 && (
                <Box flexDirection="row">
                  <Text size="footnote" tabular color="error">
                    {errors}{' '}
                  </Text>
                  <Text size="footnote" color="error">
                    {tr.errorsWord(errors)}
                  </Text>
                </Box>
              )}
              {flagged > 0 && (
                <Box flexDirection="row">
                  <Text size="footnote" color="warning">
                    ⚑ {flagged}{' '}
                  </Text>
                  <Text size="footnote" color="warning">
                    {tr.flaggedWord(flagged)}
                  </Text>
                </Box>
              )}
              {spark !== '' && <Text color="suggestion">{spark}</Text>}
            </Box>
            {chart}
          </Box>
        )}
        {all.length > 0 && (
          <Box flexDirection="row" alignItems="center" justifyContent="space-between">
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
              {filters.map(f => (
                <Button
                  key={`f-${f}`}
                  label={`${tr.filterName[f]} ${count(f)}`}
                  {...(f === shown ? { variant: 'primary' as const } : {})}
                  onPress={() => void update($, filter, () => f)}
                />
              ))}
            </Box>
            <Button key="clear" label={tr.clear} plain dimColor onPress={() => void update($, calls, () => [])} />
          </Box>
        )}
        {all.length === 0 ? (
          <Box flexDirection="column" rowGap="sm">
            <Text dimColor>{tr.emptyLog}</Text>
            {s.enabled && probe?.ok === true && (
              <Box flexDirection="row">
                <Button
                  key="empty-test"
                  label={tr.runTest}
                  onPress={() => {
                    void read($, settings)
                      .then(current => quickTest($, current))
                      .catch(error => $.ui.toast(tr.testFailed(describeError(error, tr))))
                  }}
                />
              </Box>
            )}
          </Box>
        ) : (
          <Box flexDirection="column" rowGap="sm">
            {rows}
          </Box>
        )}
      </Box>
    )
  })
}
