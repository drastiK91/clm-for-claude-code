/** Where a CLM call came from: a tool the model called, the risk hint, the output check, or /clm test. */
export type ClmSource = 'tool' | 'guard' | 'check' | 'test'

/** The languages the mod speaks to the person in (the model is always addressed in English). */
export type ClmLang = 'en' | 'it'

/** What the log shows: every call, or one source's. */
export type ClmFilter = ClmSource | 'all'

/** How a headline reads: fine, worth a look, over its threshold, or just a ranking. */
export type ClmTone = 'good' | 'warn' | 'bad' | 'neutral'

/** One option of an answer's distribution, drawn as a bar. */
export type ClmOption = {
  /** A term the drawing translates (safe, failure, yes…), or the option's own text. */
  label: string
  p: number
  /** The question it answers, when one call asked several. */
  group?: string
}

/** The one number a call is about (a command's risk, an output's failure, the best candidate), drawn as a bar. */
export type ClmHeadline = {
  /** A term the drawing translates (risk, failure), or a literal such as `#2`. */
  label: string
  p: number
  tone: ClmTone
  /** What CLM picked, beside the bar: a term (safe, success…) or a candidate's text. */
  verdict?: string
}

/** One answer from clm-serve, as the log and the band show it. */
export type ClmCall = {
  /** Unique across reloads: the time of the call and a sequence. */
  id: string
  /** Epoch milliseconds when the call was made. */
  at: number
  source: ClmSource
  /** The endpoint: /v1/rank or /v1/systemone. */
  kind: 'rank' | 'systemone'
  /** What was asked, on one short line. */
  subject: string
  /** What was asked in full (its first 2000 characters) when the subject cut or flattened it: shown when the row is opened. */
  text?: string
  /** The answer, on one short line. */
  answer: string
  /** The distribution behind the answer as text, one line per option. */
  detail: string[]
  /** The same distribution as values, best first, for the bars; absent on a failed call. */
  dist?: ClmOption[]
  headline?: ClmHeadline
  /** Round trip as the mod measured it. */
  clientMs: number
  /** X-CLM-Latency-Ms, the server's own time; null when absent. */
  serverMs: number | null
  /** Encoder tokens spent on cache misses; null when absent. */
  tokens: number | null
  ok: boolean
  error: string | null
  /** A check whose answer crossed the threshold: the model got a note. */
  flagged?: boolean
}

/** The switches, persisted in $.store and mirrored here for drawing. */
export type ClmSettings = {
  /** Master switch: off means no CLM call of any kind. */
  enabled: boolean
  /** Risk hint under Bash permission dialogs. */
  guard: boolean
  /** Silent-failure check on Bash output (a hidden note to the model). */
  check: boolean
  /** The one-line band above the prompt. */
  band: boolean
  url: string
  /** Toast when a command's destructive probability reaches this. */
  guardThreshold: number
  /** Note to the model when the failure probability reaches this. */
  checkThreshold: number
  timeoutMs: number
  /** The CLM head clm-serve answers with (`model` in the request); null for the server's default. */
  model: string | null
  /** The GGUF the encoder serves; null for Qwen3-8B Q4_K_M, looked for in LM Studio's and the mod's folders. */
  encoderModel: string | null
  /** The llama-server binary; null to look in LM Studio's backends, then on PATH. */
  encoderBin: string | null
  /** The clm-serve launcher; null to look on PATH, then in pipx's bin folder. */
  clmServeBin: string | null
  /** The port llama-server listens on (clm-serve's is the url's). */
  encoderPort: number
  /** llama-server options added after the mod's own on the start line (/clm encoder-args). */
  encoderArgs: string
  /** The footer tag: a Client (right click opens the menu) where it draws, or a plain Button. */
  tagStyle: 'auto' | 'button'
  /** The person's language; auto follows Claude Code's language setting, then the system's. */
  lang: 'auto' | ClmLang
}

export type ClmHealth = {
  ok: boolean
  at: number
  detail: string
  /** The heads clm-serve serves, as /health lists them. */
  models?: string[]
  /** clm-serve's playground mock: the numbers are fake. */
  isMock?: boolean
}

/** A process listening on one of the services' ports. */
export type ClmServiceProcess = { pid: number; name: string }

/** The services as last inspected or changed from the menu. */
export type ClmServices = {
  at: number
  encoder: ClmServiceProcess | null
  serve: ClmServiceProcess | null
  /** What is running now ("restarting…"), or null when idle. */
  busy: string | null
  /** The outcome of the last action, one line per step. */
  lines: string[]
}

declare module 'claude-code' {
  interface PluginState {
    clm: {
      settings: ClmSettings
      calls: ClmCall[]
      health: ClmHealth | null
      services: ClmServices | null
      /** The language resolved from settings.lang, so every drawing reads it at once. */
      lang: ClmLang
      filter: ClmFilter
      /** The log row opened to show its distribution, by call id; null when none is. */
      selected: string | null
    }
  }
}
