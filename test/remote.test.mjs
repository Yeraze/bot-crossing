/**
 * Other machines: a peer colony read as a harness, and the two switches that guard a colony
 * once something other than its own page can reach it.
 *
 * The peer here is a real HTTP server on loopback handing back a canned thread list, so nothing
 * depends on a second machine — or on this one having any threads at all.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { parsePeers, peerHarness } from '../server/harnesses/remote.mjs'
import { refusal } from '../server/api.mjs'
import { disambiguateProjects } from '../server/scan.mjs'
import { withEnv } from './support/env.mjs'

const THREAD = {
  id: 'claude-code:2df3987c-02d3-405e-b8f5-da30e3835213',
  title: 'Fix the scanner',
  project: 'foo',
  projectPath: '/Users/me/foo',
  cwd: '/Users/me/foo/.claude/worktrees/a',
  lastActivityAt: 1000,
  running: true,
  canOpen: true,
  ref: { cliSessionId: '2df3987c-02d3-405e-b8f5-da30e3835213' },
  harness: 'claude-code',
  harnessName: 'Claude Code',
  subagents: [{ id: 's1', task: 'look something up', lastActivityAt: 1000 }],
}

/** A stand-in peer. `reply` is swapped by the test to change what it says next. */
async function withPeer(run) {
  const peer = { reply: (req, res) => res.end(JSON.stringify({ threads: [THREAD] })), seen: [] }
  const server = http.createServer((req, res) => {
    peer.seen.push({ url: req.url, authorization: req.headers.authorization })
    peer.reply(req, res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  peer.url = `http://127.0.0.1:${server.address().port}/`
  try {
    return await run(peer)
  } finally {
    server.closeAllConnections()
    server.close()
  }
}

// ── naming the peers ──────────────────────────────────────────────────────────

test('peers parse from name=url pairs, and a bad entry costs only itself', () => {
  const warn = console.warn
  console.warn = () => {}
  try {
    const peers = parsePeers('Studio=http://192.168.1.20:5274, mini=https://mini.example.net/colony,x=http://a,nope,ftp=ftp://a,studio=http://b')
    assert.deepEqual(peers, [
      { name: 'studio', url: 'http://192.168.1.20:5274/' },
      { name: 'mini', url: 'https://mini.example.net/colony/' },
    ])
    assert.deepEqual(parsePeers(''), [])
    assert.deepEqual(parsePeers(undefined), [])
  } finally {
    console.warn = warn
  }
})

// ── what a remote thread looks like here ──────────────────────────────────────

test('a peer is a harness, and its threads arrive as that machine’s own', async () => {
  await withPeer(async (peer) => {
    const h = peerHarness({ name: 'studio', url: peer.url })
    assert.match(h.id, /^[a-z0-9-]+$/)
    assert.equal(h.setArchived, undefined)
    assert.equal(await h.detect(), true)

    const [t] = await h.scanThreads()
    assert.equal(t.id, `remote-studio:${THREAD.id}`)
    assert.equal(t.project, 'studio/foo')
    assert.equal(t.title, THREAD.title)
    assert.equal(t.running, true)
    assert.equal(t.source, 'Claude Code')
    assert.equal(peer.seen[0].url, '/api/threads')
    assert.equal(await h.diagnostic(), '')
  })
})

test('a remote thread cannot be opened, and its folder is not a path on this machine', async () => {
  await withPeer(async (peer) => {
    const h = peerHarness({ name: 'studio', url: peer.url })
    const [t] = await h.scanThreads()
    // The peer's own ref must not come along: handed back to `/api/open` under a local harness
    // id it would open this machine's app on a thread that lives on another.
    assert.equal(t.canOpen, false)
    assert.deepEqual(t.ref, {})
    assert.equal(t.projectPath, 'studio:/Users/me/foo')
    assert.equal(t.cwd, 'studio:/Users/me/foo/.claude/worktrees/a')
    assert.equal((await h.openThread(t.ref)).ok, false)
    assert.equal((await h.newSession('/Users/me/foo')).ok, false)
  })
})

test('the same repo at the same path on two machines is two zones', async () => {
  await withPeer(async (peer) => {
    const remote = await peerHarness({ name: 'studio', url: peer.url }).scanThreads()
    const out = disambiguateProjects([{ ...THREAD }, ...remote])
    assert.deepEqual(out.map((t) => t.project), ['foo', 'studio/foo'])
  })
})

test('a peer that is itself a hub does not hand its remote threads on', async () => {
  await withPeer(async (peer) => {
    const relayed = { ...THREAD, id: `remote-mini:${THREAD.id}`, harness: 'remote-mini' }
    peer.reply = (req, res) => res.end(JSON.stringify({ threads: [THREAD, relayed, null, { title: 'no id' }] }))
    const threads = await peerHarness({ name: 'studio', url: peer.url }).scanThreads()
    assert.equal(threads.length, 1)
  })
})

test('the peer token is sent as a bearer, and only when there is one', async () => {
  await withPeer(async (peer) => {
    const h = peerHarness({ name: 'studio', url: peer.url })
    await h.scanThreads()
    await withEnv({ BOT_CROSSING_PEER_TOKEN: 'sesame' }, () => h.scanThreads())
    assert.equal(peer.seen[0].authorization, undefined)
    assert.equal(peer.seen[1].authorization, 'Bearer sesame')
  })
})

// ── a peer that stops answering ───────────────────────────────────────────────

test('an unreachable peer keeps its bots, stops them working, and says so', async () => {
  await withPeer(async (peer) => {
    const h = peerHarness({ name: 'studio', url: peer.url })
    await h.scanThreads()

    peer.reply = (req, res) => res.writeHead(401).end('{}')
    const [t] = await h.scanThreads()
    assert.equal(t.id, `remote-studio:${THREAD.id}`)
    assert.equal(t.running, false)
    assert.equal(t.subagents, undefined)
    assert.match(await h.diagnostic(), /studio.*refused the token/)

    // And it recovers on its own the moment the peer does.
    peer.reply = (req, res) => res.end(JSON.stringify({ threads: [THREAD] }))
    assert.equal((await h.scanThreads())[0].running, true)
    assert.equal(await h.diagnostic(), '')
  })
})

test('a peer that was never reachable contributes nothing and does not throw', async () => {
  const h = peerHarness({ name: 'gone', url: 'http://127.0.0.1:1/' })
  assert.deepEqual(await h.scanThreads(), [])
  assert.match(await h.diagnostic(), /gone/)
})

// ── who may ask ───────────────────────────────────────────────────────────────

const ask = (method, from, headers = {}) => ({
  method,
  socket: { remoteAddress: from },
  headers: { host: '192.168.1.20:5274', ...headers },
})
const LAN = '192.168.1.50'
const page = { host: 'localhost:5274', origin: 'http://localhost:5274' }

test('with no switches set, the page check is all there is', () => {
  assert.equal(refusal(ask('GET', '127.0.0.1', page)), null)
  assert.equal(refusal(ask('POST', '127.0.0.1', page)), null)
  assert.equal(refusal(ask('GET', '127.0.0.1', { host: 'evil.example' })).status, 403)
  assert.equal(refusal(ask('POST', '127.0.0.1', { host: 'localhost:5274' })).status, 403)
})

test('read-only refuses a write from another machine, and never one from this one', async () => {
  await withEnv({ BOT_CROSSING_READONLY: '1', BOT_CROSSING_TOKEN: undefined }, () => {
    const lanPage = { host: 'localhost:5274', origin: 'http://localhost:5274' }
    assert.equal(refusal(ask('POST', LAN, lanPage)).status, 403)
    assert.equal(refusal(ask('PUT', LAN, lanPage)).status, 403)
    assert.equal(refusal(ask('GET', LAN, lanPage)), null)
    assert.equal(refusal(ask('POST', '127.0.0.1', page)), null)
    assert.equal(refusal(ask('POST', '::ffff:127.0.0.1', page)), null)
  })
})

test('a token is demanded of other machines, and a read that carries it needs no known Host', async () => {
  await withEnv({ BOT_CROSSING_TOKEN: 'sesame', BOT_CROSSING_READONLY: undefined }, () => {
    const named = { host: 'studio.local:5274' }
    assert.equal(refusal(ask('GET', LAN, named)).status, 401)
    assert.equal(refusal(ask('GET', LAN, { ...named, authorization: 'Bearer wrong' })).status, 401)
    assert.equal(refusal(ask('GET', LAN, { ...named, authorization: 'sesame' })).status, 401)
    assert.equal(refusal(ask('GET', LAN, { ...named, authorization: 'Bearer sesame' })), null)
    // The token lets a caller in; it does not make a write from nowhere into the page's.
    assert.equal(refusal(ask('POST', LAN, { ...named, authorization: 'Bearer sesame' })).status, 403)
    // This machine's own page never needed it.
    assert.equal(refusal(ask('GET', '127.0.0.1', page)), null)
    // An address that cannot be read is not assumed to be local.
    assert.equal(refusal(ask('GET', undefined, page)).status, 401)
  })
})

test('a name a reverse proxy serves the colony under is accepted as its own', async () => {
  await withEnv({ BOT_CROSSING_ALLOWED_HOSTS: ' Bots.Example.com ,other.example' }, async () => {
    const fresh = await import(`../server/api.mjs?allowed-hosts`)
    const proxied = { host: 'bots.example.com', origin: 'https://bots.example.com' }
    assert.equal(fresh.refusal(ask('PUT', '127.0.0.1', proxied)), null)
    assert.equal(fresh.refusal(ask('GET', '127.0.0.1', { host: 'evil.example' })).status, 403)
  })
  assert.equal(refusal(ask('GET', '127.0.0.1', { host: 'bots.example.com' })).status, 403)
})
