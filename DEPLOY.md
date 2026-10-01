# Deploying one colony for several machines

One machine is the **hub**: it serves the page, sits behind your reverse proxy, and is the only
thing you open in a browser. Every other machine is a **peer**: it runs the scanner with no page
and answers the hub over HTTP.

```
browser ──https──▶ reverse proxy ──▶ hub (127.0.0.1:5274) ──GET /api/threads──▶ peer (studio)
                   (TLS + auth)       also shows its own threads               ▶ peer (mini)
```

Assumptions these steps make — change them if they are wrong for you:

- The proxy runs on the same machine as the hub. (If not, see [Proxy on another host](#proxy-on-another-host).)
- Peers are reachable from the hub on a network you trust, or over a VPN/mesh such as Tailscale.
- Every machine runs Linux with systemd, Node 22.13 or newer, and `git`.

## 1. Make a token

Once, anywhere:

```bash
openssl rand -hex 32
```

Every peer demands this; the hub sends it. Keep it out of shell history and out of git.

## 2. Set up each peer

```bash
git clone -b remote-peers git@github.com:Yeraze/bot-crossing.git ~/bot-crossing
```

No `npm install` and no build: a peer only runs `server/`, which uses nothing but Node itself.

Put the settings in `~/bot-crossing/peer.env` (mode `600`):

```bash
BOT_CROSSING_HOST=100.64.0.3
BOT_CROSSING_TOKEN=<the token>
BOT_CROSSING_READONLY=1
PORT=5274
```

`BOT_CROSSING_HOST` is the address the hub will reach this machine on. Bind to that one address
— the Tailscale or LAN IP — rather than `0.0.0.0`, so the scanner
is not offered on every network the machine ever joins. This matters most on a laptop.

Try it by hand first:

```bash
cd ~/bot-crossing && (set -a; . ./peer.env; set +a; node server/serve.mjs)
```

From the hub machine, check it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://100.64.0.3:5274/api/threads
```

```bash
curl -s -H 'Authorization: Bearer <the token>' http://100.64.0.3:5274/api/harnesses
```

The first must print `401`. The second must list the harnesses, with `"detected":true` for the
ones installed on that peer.

### Keep it running

`~/.config/systemd/user/botcrossing-peer.service`. It has to be a *user* unit, not a system one:
the scanner reads files in your home directory.

```ini
[Unit]
Description=Bot Crossing peer
After=network-online.target

[Service]
WorkingDirectory=%h/bot-crossing
EnvironmentFile=%h/bot-crossing/peer.env
ExecStart=/usr/bin/node server/serve.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now botcrossing-peer && loginctl enable-linger "$USER"
```

Use the output of `which node` for the node path. `enable-linger` keeps the service up while you
are logged out. `Restart=always` also covers a bind address — a VPN interface, say — that is not
up yet at boot: the server exits and is retried.

## 3. Set up the hub

```bash
git clone -b remote-peers git@github.com:Yeraze/bot-crossing.git ~/bot-crossing
```

```bash
cd ~/bot-crossing && npm ci && npm run build
```

`~/bot-crossing/hub.env` (mode `600`):

```bash
BOT_CROSSING_PEERS=studio=http://100.64.0.3:5274,mini=http://100.64.0.4:5274
BOT_CROSSING_PEER_TOKEN=<the token>
BOT_CROSSING_ALLOWED_HOSTS=bots.example.com
PORT=5274
```

- The name before each `=` is what the machine is called on the map (`studio/my-repo`). Lower-case
  letters, digits and dashes, at least two characters. **Pick names you will keep**: saved zone
  positions and the archive list are keyed on them, so renaming a peer starts its zones over.
- Leave `BOT_CROSSING_HOST` unset. The hub stays on `127.0.0.1` and only the proxy can reach it.
- Do **not** set `BOT_CROSSING_READONLY` or `BOT_CROSSING_TOKEN` on the hub in this layout. Behind
  a proxy on the same machine every caller looks local, so neither would do anything.

Run it from `~/.config/systemd/user/botcrossing-hub.service` — the peer's unit with
`EnvironmentFile=%h/bot-crossing/hub.env` — and enable it the same way. `data/colony.json` — the map and your archive list for *all* machines — lives
in this checkout; back it up if you care about the layout.

The hub also shows its own machine's threads. On a server with no agent harness installed that
is simply nothing, and the colony is the peers alone.

## 4. Reverse proxy

The hub has no login of its own, and its API can open apps, reveal folders and start sessions on
the hub machine. **Authentication on the proxy is not optional.**

**Caddy:**

```
bots.example.com {
    basic_auth {
        you <output of `caddy hash-password`>
    }
    reverse_proxy 127.0.0.1:5274
}
```

**nginx:**

```nginx
server {
    listen 443 ssl;
    server_name bots.example.com;
    # ssl_certificate / ssl_certificate_key …

    auth_basic "Bot Crossing";
    auth_basic_user_file /etc/nginx/botcrossing.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:5274;
        proxy_set_header Host $host;
    }
}
```

Nothing else is needed — no WebSockets, no long-lived connections; the page polls every 15 seconds.
An SSO layer (oauth2-proxy, Authelia, Cloudflare Access, Tailscale Serve) works in place of basic
auth as long as it leaves `Host` and `Origin` alone.

## 5. Check the whole thing

1. On the hub machine: `curl -s http://127.0.0.1:5274/api/harnesses` — each peer appears as
   `remote-<name>` with `"error":""`. An error string there says what is wrong (`refused the
   token`, `ECONNREFUSED`, `did not answer in time`).
2. In a browser: `https://bots.example.com` asks for the login, then shows the colony with a zone
   per machine-and-repo.
3. Without credentials: `curl -s -o /dev/null -w '%{http_code}\n' https://bots.example.com/api/threads`
   prints `401`.

## Updating

Peers: `git pull` and restart the service. Hub: `git pull && npm ci && npm run build`, then
restart. Update the hub and peers together when the thread shape changes.

## What to expect

- Remote bots are for looking at: Open, New conversation and Finder are refused for them. Archive
  and Viewed work and are stored on the hub only.
- A peer that is asleep or off keeps its bots on the map, idle, and the page says once that it
  could not be read. Since a hub restart forgets what a peer last said, an unreachable peer
  contributes nothing until it answers again.
- A thread's "waiting on you" state comes from the peer's own harness. Answering it there clears
  it here on the next poll; **Viewed** clears it here without touching the peer.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Page loads through the proxy, every `/api` call is `403` | The public hostname is missing from `BOT_CROSSING_ALLOWED_HOSTS`, or the proxy rewrites `Origin` |
| Peer shows `refused the token` | `BOT_CROSSING_PEER_TOKEN` on the hub differs from `BOT_CROSSING_TOKEN` on that peer |
| Peer shows `ECONNREFUSED` / times out | Peer not running, bound to a different address than the hub uses, or a firewall |
| Peer answers `403` to the hub with no token configured | Without a token the peer still checks `Host`: address it by IP, or set a token (recommended) |
| Peer is up but lists no threads | It runs as a different user than the one whose harness data you want, or as a system service |
| A peer exits at boot with `EADDRNOTAVAIL` | Its bind address was not up yet; the service's restart setting retries it |

## Proxy on another host

If the proxy is not on the hub machine, the hub has to listen on the network, and then it needs
its own guard:

- Hub: add `BOT_CROSSING_HOST=<hub address>` and `BOT_CROSSING_TOKEN=<a second token>`.
- Proxy: send that token on every request — `proxy_set_header Authorization "Bearer <token>";` in
  nginx, `header_up Authorization "Bearer <token>"` inside `reverse_proxy` in Caddy — and forward
  the public `Host` as above.

The proxy still does the user-facing login; the token only ensures nothing but the proxy can talk
to the hub. The token crosses that hop in the clear unless it is `https` or a private network.
