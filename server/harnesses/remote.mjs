/**
 * Harness adapter: another machine's Bot Crossing.
 *
 * A colony on one machine can show the threads of several. Every instance already answers
 * `GET /api/threads` with exactly the shape an adapter returns, so a peer is just one more
 * harness: this asks it over HTTP instead of reading files, and the scanner, the API and the
 * page never learn that some of the bots live somewhere else.
 *
 * One adapter per peer rather than one for all of them, for two reasons. The id is what
 * `/api/open` dispatches on, so a remote thread's click arrives here and is refused — merged in
 * under `claude-code` it would be handed to this machine's desktop app, which has never heard of
 * it. And a peer that is down then says so by name, through the same `diagnostic()` any other
 * harness uses.
 *
 * Read-only in both directions: nothing is written here, and nothing but a GET is ever sent
 * there. Off entirely unless `BOT_CROSSING_PEERS` is set.
 */

/** How long a peer gets to answer before the attempt is abandoned. */
const REFRESH_TIMEOUT_MS = 5000
/**
 * How long a scan waits on that attempt. Shorter on purpose: the scan runs on a poll and every
 * harness shares it, so a laptop that went to sleep must not hold up the bots on the machines
 * that are awake. Past this the last answer is served and the attempt finishes on its own.
 */
const SCAN_BUDGET_MS = 1500

/**
 * `studio=http://192.168.1.20:5274,mini=https://mini.example.net`.
 *
 * The name is lower-case letters, digits and dashes because it becomes a harness id, and at
 * least two characters because it is also prefixed onto paths as `name:/path` — where a single
 * letter is a Windows drive. A malformed entry is skipped rather than fatal: one typo should
 * not take the local colony down with it.
 */
export function parsePeers(spec = '') {
  const peers = []
  const seen = new Set()
  for (const entry of String(spec).split(',').map((s) => s.trim()).filter(Boolean)) {
    const cut = entry.indexOf('=')
    const name = cut > 0 ? entry.slice(0, cut).trim().toLowerCase() : ''
    let url = null
    try {
      url = new URL(entry.slice(cut + 1).trim())
    } catch {
      /* reported below with every other reason an entry is unusable */
    }
    if (!/^[a-z0-9][a-z0-9-]+$/.test(name) || !url || !/^https?:$/.test(url.protocol) || seen.has(name)) {
      console.warn(`bot-crossing: ignoring peer "${name || entry}" — expected name=http://host:port, each name once`)
      continue
    }
    seen.add(name)
    // So a peer served under a path prefix keeps it: `api/threads` resolves against the folder.
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    url.search = ''
    url.hash = ''
    peers.push({ name, url: url.href })
  }
  return peers
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref())

export function peerHarness({ name, url }) {
  const id = `remote-${name}`
  let threads = []
  let error = ''
  let inFlight = null

  // `studio:/Users/me/foo`, the way scp writes it. Left bare, a path that happens to exist on
  // this machine too — the same checkout in the same place, which is the usual arrangement —
  // would open *this* machine's folder from a zone that belongs to another one. Prefixed it is
  // not an absolute path, so the server refuses it, and Copy path hands over something useful.
  const there = (p) => (typeof p === 'string' && p ? `${name}:${p}` : '')

  const adopt = (t) => ({
    ...t,
    id: `${id}:${t.id}`,
    // A zone per machine: the same repo checked out on two of them is two places.
    project: `${name}/${t.project || 'unknown'}`,
    projectPath: there(t.projectPath),
    cwd: there(t.cwd),
    // The scanner stamps `harness` with this adapter; what actually ran the thread goes here.
    source: t.harnessName || t.harness || '',
    canOpen: false,
    ref: {},
  })

  // A peer that is itself a hub hands back its own remote threads. Taking those would count a
  // machine twice, and two hubs pointed at each other would grow each other's list forever.
  const own = (t) => t && typeof t.id === 'string' && t.id && !String(t.harness || '').startsWith('remote-')

  async function refresh() {
    try {
      const token = process.env.BOT_CROSSING_PEER_TOKEN
      const res = await fetch(new URL('api/threads', url), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      })
      if (res.status === 401) throw new Error('it refused the token')
      if (!res.ok) throw new Error(`it answered ${res.status}`)
      const body = await res.json()
      if (!Array.isArray(body?.threads)) throw new Error('it did not answer with a thread list')
      threads = body.threads.filter(own).map(adopt)
      error = ''
    } catch (err) {
      const why = err?.name === 'TimeoutError' ? 'it did not answer in time' : err?.cause?.code || err?.message || 'unknown'
      error = `Could not read ${name}’s threads (${why}) — showing what it last reported`
    }
  }

  /**
   * What a peer last said, when it cannot be asked. Dropping its threads instead would walk
   * every one of its bots back to the ship each time a laptop lid closes. But nothing it said
   * about *right now* can be trusted any more, so nobody is hammering and no errand is out.
   */
  const quiet = (t) => (t.running || t.subagents ? { ...t, running: false, subagents: undefined } : t)

  return {
    id,
    name,
    // Configured is present. Whether it can be reached is `diagnostic()`'s to say.
    detect: async () => true,
    async scanThreads() {
      inFlight ||= refresh().finally(() => {
        inFlight = null
      })
      await Promise.race([inFlight, pause(SCAN_BUDGET_MS)])
      return error ? threads.map(quiet) : threads
    },
    diagnostic: async () => error,
    openThread: () => ({ ok: false, error: `That thread lives on ${name} — open it there` }),
    newSession: () => ({ ok: false, error: `That repo lives on ${name} — start the session there` }),
  }
}

/** Read once, at import, like every other root an adapter resolves: changing it wants a restart. */
export const remoteHarnesses = () => parsePeers(process.env.BOT_CROSSING_PEERS).map(peerHarness)
