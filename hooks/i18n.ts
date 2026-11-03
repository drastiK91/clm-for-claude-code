// What the mod says to the person, in English and Italian. What it says to the model (tool
// descriptions, refusals, the check's note) stays in English and lives in register.tsx.

import type { ClmFilter, ClmLang, ClmSource } from '../types'
import type { Problem, StopEntry } from './services'

const EN = {
  langName: 'English',

  lampOff: 'CLM-8B off',
  lampChecking: 'CLM-8B checking…',
  lampOffline: 'CLM-8B offline',
  lampReady: 'CLM-8B ready',
  lampMock: 'CLM-8B ready (mock)',

  on: 'on',
  off: 'off',
  none: 'none',
  yes: 'yes',
  no: 'no',
  error: 'error',
  noAnswer: 'no answer',
  noCandidate: 'no candidate',
  notChecked: 'not checked yet',
  notFound: 'not found',
  reachable: 'reachable',
  unreachable: 'unreachable',
  stopped: 'stopped',
  risk: 'risk',
  failure: 'failure',
  outOf: (score: string, top: number) => `${score} of ${top}`,

  timeout: (ms: number) => `no answer within ${ms} ms`,
  overflow: (tokens: number) => `input of ${tokens} tokens over the encoder's 2048`,
  paused: (seconds: number) => `guard and check paused for ${seconds} s`,
  pausedAfter: (strikes: number) => `Guard and check are paused after ${strikes} timeout${strikes === 1 ? '' : 's'} in a row (they resume by themselves).`,
  serverDown: (reason: string) => `clm-serve unreachable (${reason})`,
  connRefused: 'connection refused',
  /** What the answers' keys and the hooks' headlines say: safe, failure, yes… */
  term: {
    risk: 'risk',
    failure: 'failure',
    success: 'success',
    safe: 'safe',
    destructive: 'destructive',
    exfiltration: 'exfiltration',
    yes: 'yes',
    no: 'no',
  } as Record<string, string>,
  healthModels: (models: string[]) => (models.length === 0 ? 'clm-serve ready' : `heads: ${models.join(', ')}`),
  healthNoEncoder: 'clm-serve is up, but its encoder (llama-server) is unreachable',
  badKey: 'HTTP 401: CLM_API_KEY is missing or wrong for this server',

  problem: (p: Problem): string => {
    switch (p.kind) {
      case 'remote':
        return `The server is remote (${p.url}): the mod manages services on this machine only.`
      case 'no-llama':
        return 'llama-server not found in LM Studio\'s backends nor on PATH: install llama.cpp (brew install llama.cpp, or a release from github.com/ggml-org/llama.cpp) or LM Studio, or set it with /clm llama <path>.'
      case 'no-model':
        return (
          `Encoder model missing: ${p.model}\n` +
          'CLM-8B is trained on Qwen3-8B: download it (5.0 GB) with\n' +
          `  hf download Qwen/Qwen3-8B-GGUF Qwen3-8B-Q4_K_M.gguf --local-dir "${p.dir}"\n` +
          'or point at another file with /clm encoder <path.gguf>.'
        )
      case 'no-serve':
        return 'clm-serve not found on PATH: install it with pip install contrastive-lm (or pipx), or set it with /clm serve <path>.'
      case 'unsafe-path':
        return `Path with characters the start line cannot carry: ${p.path}`
      case 'bad-args':
        return p.reason.kind === 'chars'
          ? 'Encoder options not allowed: only letters, digits, spaces and . : = / \\ , + - (change them with /clm encoder-args <options>|default).'
          : `Encoder options not allowed, the mod sets them itself: ${p.reason.flags.join(' ')} (change them with /clm encoder-args <options>|default).`
    }
  },
  stopLine: (entry: StopEntry): string =>
    entry.what === 'stopped'
      ? `port ${entry.port}: stopped ${entry.name} (PID ${entry.pid})`
      : entry.what === 'free'
        ? `port ${entry.port}: already free`
        : `port ${entry.port}: held by ${entry.name} (PID ${entry.pid}), which the mod leaves alone`,
  startFailed: (code: string, stderr: string) => `start failed (code ${code})${stderr === '' ? '' : `: ${stderr}`}`,
  encoderStarted: (pid: number, port: number) => `encoder started (PID ${pid}) on port ${port}`,
  serveStarted: (pid: number, port: number) => `clm-serve started (PID ${pid}) on port ${port}`,
  logsIn: (dir: string) => `logs in ${dir}`,
  busyRestart: 'restarting the services…',
  busyStop: 'stopping the services…',
  otherAction: 'Another service action is running: wait for it to finish.',
  afterRestartOn: 'The dot turns green as soon as they answer (the model loads in about 20 s).',
  afterRestartOff: 'CLM is off: /clm on to use them.',

  svcEncoder: 'encoder',
  svcLlama: 'llama-server',
  svcModel: 'encoder model',
  svcArgs: 'encoder options',
  svcServe: 'clm-serve',
  svcLogs: 'logs',
  svcPort: 'port',
  svcToFix: 'To fix before a restart:',

  badPathChars: 'Path with characters that are not allowed (" % & | < > ^ \').',
  notGguf: 'The encoder model is a .gguf file.',
  fileNotFound: (path: string) => `File not found: ${path}`,
  pathSet: (what: 'encoder' | 'llama' | 'serve', value: string) =>
    `${what === 'encoder' ? 'Encoder model' : what === 'llama' ? 'llama-server' : 'clm-serve'}: ${value}. Takes effect at the next service restart (/clm restart).`,
  encoderArgsIs: (args: string) => `Encoder options: ${args === '' ? '(none)' : args}. Usage: /clm encoder-args <options>|default`,
  encoderArgsSet: (args: string) => `Encoder options: ${args}. They take effect at the next service restart (/clm restart).`,
  tagAuto: 'Footer tag with a right-click menu, where the surface allows it.',
  tagButton: 'Footer tag as a plain button (the menu is /clm menu).',
  langSet: (choice: 'auto' | ClmLang) => `Language: English${choice === 'auto' ? ' (automatic)' : ''}.`,
  usage: (args: string) => `Usage: /clm ${args}`,

  onReady: (detail: string, hasBand: boolean) => `CLM-8B on. ${detail}. ${hasBand ? 'Answers show above the prompt; ' : ''}/clm log for the history.`,
  onOffline: (detail: string, url: string) =>
    `CLM-8B on, but the server does not answer: ${detail}.\nStart the encoder (llama-server) and clm-serve (${url}), or /clm restart: the dot turns green by itself as soon as they answer.`,
  offDone: 'CLM-8B off: no CLM calls, tools hidden from the model. /clm on to turn it back on.',
  urlLater: (url: string) => `URL set: ${url}. Checked the next time CLM is turned on (/clm on).`,
  urlSet: (url: string, outcome: string) => `URL set: ${url} — ${outcome}`,
  modelIs: (model: string | null, models: string[]) =>
    `CLM head: ${model ?? 'server default'}.${models.length > 0 ? ` Available: ${models.join(', ')}.` : ''} Usage: /clm model <name>|default`,
  modelUnknown: (name: string, models: string[]) => `clm-serve does not serve «${name}». Available: ${models.join(', ')}.`,
  modelSet: (model: string | null) => `CLM head: ${model ?? 'server default'}.`,
  thresholdSet: (what: 'guard' | 'check', value: string) => `${what === 'guard' ? 'Guard warns' : 'Check notes'} from ${value}.`,
  logOpened: 'CLM-8B log opened.',
  logFallback: (reason: string) => `The pane cannot open here (${reason}). Latest answers:`,
  logUnavailable: 'The log cannot open here: use /clm log',
  cleared: 'CLM-8B log cleared.',
  menuOpened: 'CLM-8B menu opened (also with a right click on the footer tag).',
  testOff: 'CLM-8B is off: /clm on to turn it on.',
  testOffToast: 'CLM-8B is off: turn it on with 1',
  testResult: (answer: string, ms: string) => `CLM-8B test: ${answer} · ${ms}`,
  testFailed: (reason: string) => `Test failed: ${reason}`,
  unknownVerb: (verb: string) => `Unknown command «${verb}».`,
  guardNotice: (risk: string, ms: string) => `CLM-8B (estimate): risk ${risk} · ${ms}`,
  guardToast: (risk: string) => `CLM-8B: risky command per the estimate (${risk})`,

  colFeature: 'Feature',
  colState: 'State',
  colNotes: 'Notes',
  featTools: 'Tools for the model',
  featGuard: 'Guard — risk hint under Bash permission prompts',
  featCheck: 'Check — silent failures in Bash output',
  featBand: 'Band above the prompt',
  featHead: 'CLM head',
  defaultHead: 'server default',
  warnFrom: (p: string) => `warns from ${p}`,
  noteFrom: (p: string) => `notes from ${p}`,
  statusFooter: '`/clm help` lists every command · right-click the CLM tag in the footer (or `/clm menu`) for the menu.',
  helpTitle: '**CLM-8B** — commands',
  help: [
    ['on · off', 'switch CLM on (tools, guard, check) or off (no calls at all)'],
    ['status', 'what is on, and whether the server answers'],
    ['menu', 'services and switches in one menu (also: right-click the footer tag)'],
    ['log', 'every answer with its bars and latency'],
    ['test', 'a quick ranking, to see CLM answer'],
    ['clear', 'empty the log'],
    ['restart · stop · services', 'manage llama-server and clm-serve on this machine'],
    ['guard on|off|<1-99>', 'risk hint under Bash permission prompts, or its threshold in %'],
    ['check on|off|<1-99>', 'silent-failure check on Bash output, or its threshold in %'],
    ['band on|off', 'the last answer above the prompt'],
    ['model <name>|default', 'the CLM head clm-serve answers with'],
    ['url <url>', 'where clm-serve listens (CLM_API_KEY is sent when set)'],
    ['encoder <file.gguf>|default', 'the encoder model'],
    ['llama <path>|default · serve <path>|default', 'the llama-server and clm-serve binaries'],
    ['encoder-args <options>|default', 'extra llama-server options'],
    ['tag auto|button', 'the footer tag: right-click menu, or a plain button'],
    ['lang auto|en|it', 'the language the mod speaks'],
  ] as [string, string][],

  sectionServices: 'SERVICES',
  sectionFeatures: 'FEATURES',
  menuTurnOff: 'Turn CLM off',
  menuTurnOn: 'Turn CLM on',
  menuRestart: 'Restart services (encoder + clm-serve)',
  menuStop: 'Stop services',
  menuRefresh: 'Refresh service status',
  menuLog: 'Open the log',
  menuTest: 'Quick test',
  guardHint: 'risk hint under Bash permission prompts',
  checkHint: 'silent failures in Bash output',
  bandHint: 'last answer above the prompt',
  menuHead: 'Head',
  menuLang: 'Language',
  menuClose: 'Close (Esc)',

  head: 'head',
  flagged: 'note sent to the model',
  clear: 'Clear',
  emptyLog: 'No answers yet. Run a quick test, or ask Claude to rank a few options with CLM.',
  status: { ready: 'Ready', mock: 'Ready (mock)', offline: 'Offline', off: 'Off', checking: 'Checking…' },
  restartShort: 'Restart services',
  runTest: 'Run a quick test',
  callsWord: (n: number): string => (n === 1 ? 'call' : 'calls'),
  errorsWord: (n: number): string => (n === 1 ? 'error' : 'errors'),
  flaggedWord: (_n: number): string => 'flagged',
  chartAlt: (n: number, p50: string, p95: string) => `Latency of the last ${n} CLM calls: p50 ${p50}, p95 ${p95}`,
  filterName: { all: 'All', tool: 'Tool', guard: 'Guard', check: 'Check', test: 'Test' } as Record<ClmFilter, string>,
  sourceBadge: { tool: 'TOOL ', guard: 'GUARD', check: 'CHECK', test: 'TEST ' } as Record<ClmSource, string>,

  commandDescription: 'CLM-8B: switch the verifier on/off, see its status, menu and log of answers',
}

export type Strings = typeof EN

const IT: Strings = {
  langName: 'Italiano',

  lampOff: 'CLM-8B spento',
  lampChecking: 'CLM-8B verifica…',
  lampOffline: 'CLM-8B offline',
  lampReady: 'CLM-8B pronto',
  lampMock: 'CLM-8B pronto (mock)',

  on: 'on',
  off: 'off',
  none: 'nessuna',
  yes: 'sì',
  no: 'no',
  error: 'errore',
  noAnswer: 'nessuna risposta',
  noCandidate: 'nessun candidato',
  notChecked: 'non ancora verificato',
  notFound: 'non trovato',
  reachable: 'raggiungibile',
  unreachable: 'NON raggiungibile',
  stopped: 'fermo',
  risk: 'rischio',
  failure: 'fallimento',
  outOf: (score, top) => `${score} su ${top}`,

  timeout: ms => `nessuna risposta entro ${ms} ms`,
  overflow: tokens => `input di ${tokens} token oltre i 2048 dell'encoder`,
  paused: seconds => `guard e check in pausa per ${seconds} s`,
  pausedAfter: strikes => `Guard e check sono in pausa dopo ${strikes} timeout di fila (riprendono da soli).`,
  serverDown: reason => `clm-serve non raggiungibile (${reason})`,
  connRefused: 'connessione rifiutata',
  term: {
    risk: 'rischio',
    failure: 'fallimento',
    success: 'successo',
    safe: 'sicuro',
    destructive: 'distruttivo',
    exfiltration: 'esfiltrazione',
    yes: 'sì',
    no: 'no',
  },
  healthModels: models => (models.length === 0 ? 'clm-serve pronto' : `head: ${models.join(', ')}`),
  healthNoEncoder: 'clm-serve attivo, ma il suo encoder (llama-server) non è raggiungibile',
  badKey: 'HTTP 401: CLM_API_KEY mancante o errata per questo server',

  problem: p => {
    switch (p.kind) {
      case 'remote':
        return `Il server è remoto (${p.url}): la mod gestisce solo servizi su questa macchina.`
      case 'no-llama':
        return 'llama-server non trovato né tra i backend di LM Studio né nel PATH: installa llama.cpp (brew install llama.cpp, o una release da github.com/ggml-org/llama.cpp) o LM Studio, oppure indicalo con /clm llama <percorso>.'
      case 'no-model':
        return (
          `Modello encoder mancante: ${p.model}\n` +
          'CLM-8B è addestrato su Qwen3-8B: scaricalo (5,0 GB) con\n' +
          `  hf download Qwen/Qwen3-8B-GGUF Qwen3-8B-Q4_K_M.gguf --local-dir "${p.dir}"\n` +
          'oppure indica un altro file con /clm encoder <percorso.gguf>.'
        )
      case 'no-serve':
        return 'clm-serve non trovato nel PATH: installalo con pip install contrastive-lm (o pipx), oppure indicalo con /clm serve <percorso>.'
      case 'unsafe-path':
        return `Percorso con caratteri che la riga di avvio non può contenere: ${p.path}`
      case 'bad-args':
        return p.reason.kind === 'chars'
          ? 'Opzioni encoder non ammesse: solo lettere, cifre, spazi e . : = / \\ , + - (cambiale con /clm encoder-args <opzioni>|default).'
          : `Opzioni encoder non ammesse, le imposta la mod: ${p.reason.flags.join(' ')} (cambiale con /clm encoder-args <opzioni>|default).`
    }
  },
  stopLine: entry =>
    entry.what === 'stopped'
      ? `porta ${entry.port}: fermato ${entry.name} (PID ${entry.pid})`
      : entry.what === 'free'
        ? `porta ${entry.port}: già libera`
        : `porta ${entry.port}: occupata da ${entry.name} (PID ${entry.pid}), che la mod non ferma`,
  startFailed: (code, stderr) => `avvio non riuscito (codice ${code})${stderr === '' ? '' : `: ${stderr}`}`,
  encoderStarted: (pid, port) => `encoder avviato (PID ${pid}) sulla porta ${port}`,
  serveStarted: (pid, port) => `clm-serve avviato (PID ${pid}) sulla porta ${port}`,
  logsIn: dir => `log in ${dir}`,
  busyRestart: 'riavvio dei servizi in corso…',
  busyStop: 'arresto dei servizi in corso…',
  otherAction: 'Un\'altra operazione sui servizi è in corso: attendi che finisca.',
  afterRestartOn: 'Il pallino diventa verde appena rispondono (il modello si carica in circa 20 s).',
  afterRestartOff: 'CLM è spento: /clm on per usarli.',

  svcEncoder: 'encoder',
  svcLlama: 'llama-server',
  svcModel: 'modello encoder',
  svcArgs: 'opzioni encoder',
  svcServe: 'clm-serve',
  svcLogs: 'log',
  svcPort: 'porta',
  svcToFix: 'Da sistemare prima di un riavvio:',

  badPathChars: 'Percorso con caratteri non ammessi (" % & | < > ^ \').',
  notGguf: 'Il modello encoder è un file .gguf.',
  fileNotFound: path => `File non trovato: ${path}`,
  pathSet: (what, value) =>
    `${what === 'encoder' ? 'Modello encoder' : what === 'llama' ? 'llama-server' : 'clm-serve'}: ${value}. Vale dal prossimo riavvio dei servizi (/clm riavvia).`,
  encoderArgsIs: args => `Opzioni encoder: ${args === '' ? '(nessuna)' : args}. Uso: /clm encoder-args <opzioni>|default`,
  encoderArgsSet: args => `Opzioni encoder: ${args}. Valgono dal prossimo riavvio dei servizi (/clm riavvia).`,
  tagAuto: 'Tag nel footer con menu al clic destro, dove la superficie lo permette.',
  tagButton: 'Tag nel footer come pulsante semplice (il menu è /clm menu).',
  langSet: choice => `Lingua: italiano${choice === 'auto' ? ' (automatica)' : ''}.`,
  usage: args => `Uso: /clm ${args}`,

  onReady: (detail, hasBand) => `CLM-8B attivo. ${detail}. ${hasBand ? 'Le risposte compaiono sopra il prompt; ' : ''}/clm log per lo storico.`,
  onOffline: (detail, url) =>
    `CLM-8B attivo, ma il server non risponde: ${detail}.\nAvvia l'encoder (llama-server) e clm-serve (${url}), o /clm riavvia: il pallino diventa verde da solo appena rispondono.`,
  offDone: 'CLM-8B spento: nessuna chiamata a CLM, tool nascosti al modello. /clm on per riattivarlo.',
  urlLater: url => `URL impostato: ${url}. Verrà verificato alla prossima accensione (/clm on).`,
  urlSet: (url, outcome) => `URL impostato: ${url} — ${outcome}`,
  modelIs: (model, models) =>
    `Head CLM: ${model ?? 'predefinita del server'}.${models.length > 0 ? ` Disponibili: ${models.join(', ')}.` : ''} Uso: /clm model <nome>|default`,
  modelUnknown: (name, models) => `clm-serve non serve «${name}». Disponibili: ${models.join(', ')}.`,
  modelSet: model => `Head CLM: ${model ?? 'predefinita del server'}.`,
  thresholdSet: (what, value) => `${what === 'guard' ? 'Il guard avvisa' : 'Il check segnala'} da ${value}.`,
  logOpened: 'Registro CLM-8B aperto.',
  logFallback: reason => `Il pannello non si può aprire qui (${reason}). Ultime risposte:`,
  logUnavailable: 'Registro non apribile qui: usa /clm log',
  cleared: 'Registro CLM-8B svuotato.',
  menuOpened: 'Menu CLM-8B aperto (anche con il clic destro sul tag nel footer).',
  testOff: 'CLM-8B è spento: /clm on per attivarlo.',
  testOffToast: 'CLM-8B è spento: accendilo con 1',
  testResult: (answer, ms) => `Test CLM-8B: ${answer} · ${ms}`,
  testFailed: reason => `Test fallito: ${reason}`,
  unknownVerb: verb => `Comando sconosciuto «${verb}».`,
  guardNotice: (risk, ms) => `CLM-8B (stima): rischio ${risk} · ${ms}`,
  guardToast: risk => `CLM-8B: comando a rischio secondo la stima (${risk})`,

  colFeature: 'Funzione',
  colState: 'Stato',
  colNotes: 'Note',
  featTools: 'Tool per il modello',
  featGuard: 'Guard — stima del rischio sotto i permessi Bash',
  featCheck: 'Check — fallimenti silenziosi nell\'output Bash',
  featBand: 'Band sopra il prompt',
  featHead: 'Head CLM',
  defaultHead: 'predefinita del server',
  warnFrom: p => `avvisa da ${p}`,
  noteFrom: p => `segnala da ${p}`,
  statusFooter: '`/clm aiuto` elenca tutti i comandi · clic destro sul tag CLM nel footer (o `/clm menu`) per il menu.',
  helpTitle: '**CLM-8B** — comandi',
  help: [
    ['on · off', 'accende CLM (tool, guard, check) o lo spegne (nessuna chiamata)'],
    ['status', 'cosa è attivo, e se il server risponde'],
    ['menu', 'servizi e interruttori in un menu (anche: clic destro sul tag nel footer)'],
    ['log', 'ogni risposta con le sue barre e la latenza'],
    ['test', 'una classifica veloce, per vedere CLM rispondere'],
    ['clear', 'svuota il registro'],
    ['riavvia · ferma · servizi', 'gestisce llama-server e clm-serve su questa macchina'],
    ['guard on|off|<1-99>', 'stima del rischio sotto i permessi Bash, o la sua soglia in %'],
    ['check on|off|<1-99>', 'controllo dei fallimenti silenziosi nell\'output Bash, o la sua soglia in %'],
    ['band on|off', 'l\'ultima risposta sopra il prompt'],
    ['model <nome>|default', 'la head CLM con cui risponde clm-serve'],
    ['url <url>', 'dove ascolta clm-serve (CLM_API_KEY viene inviata se impostata)'],
    ['encoder <file.gguf>|default', 'il modello encoder'],
    ['llama <percorso>|default · serve <percorso>|default', 'i binari di llama-server e clm-serve'],
    ['encoder-args <opzioni>|default', 'opzioni extra per llama-server'],
    ['tag auto|button', 'il tag nel footer: menu al clic destro, o pulsante semplice'],
    ['lang auto|en|it', 'la lingua della mod'],
  ],

  sectionServices: 'SERVIZI',
  sectionFeatures: 'FUNZIONI',
  menuTurnOff: 'Spegni CLM',
  menuTurnOn: 'Accendi CLM',
  menuRestart: 'Riavvia servizi (encoder + clm-serve)',
  menuStop: 'Ferma servizi',
  menuRefresh: 'Aggiorna stato servizi',
  menuLog: 'Apri il registro',
  menuTest: 'Test rapido',
  guardHint: 'stima del rischio sotto i permessi Bash',
  checkHint: 'fallimenti silenziosi nell\'output Bash',
  bandHint: 'ultima risposta sopra il prompt',
  menuHead: 'Head',
  menuLang: 'Lingua',
  menuClose: 'Chiudi (Esc)',

  head: 'head',
  flagged: 'nota al modello',
  clear: 'Svuota',
  emptyLog: 'Nessuna risposta ancora. Fai un test rapido, o chiedi a Claude di classificare qualche opzione con CLM.',
  status: { ready: 'Pronto', mock: 'Pronto (mock)', offline: 'Offline', off: 'Spento', checking: 'Verifica…' },
  restartShort: 'Riavvia servizi',
  runTest: 'Test rapido',
  callsWord: n => (n === 1 ? 'chiamata' : 'chiamate'),
  errorsWord: n => (n === 1 ? 'errore' : 'errori'),
  flaggedWord: n => (n === 1 ? 'segnalata' : 'segnalate'),
  chartAlt: (n, p50, p95) => `Latenza delle ultime ${n} chiamate CLM: p50 ${p50}, p95 ${p95}`,
  filterName: { all: 'Tutte', tool: 'Tool', guard: 'Guard', check: 'Check', test: 'Test' },
  sourceBadge: { tool: 'TOOL ', guard: 'GUARD', check: 'CHECK', test: 'TEST ' },

  commandDescription: 'CLM-8B: accendi/spegni il verificatore, vedi stato, menu e registro delle risposte',
}

export const STRINGS: Record<ClmLang, Strings> = { en: EN, it: IT }

/** Whether a language name or locale says Italian: `it`, `it-IT`, `it_IT.UTF-8`, `italian`, `Italiano`. */
export function isItalian(value: unknown): boolean {
  return typeof value === 'string' && /^(it([_-]|\.|$)|ital)/i.test(value.trim())
}
