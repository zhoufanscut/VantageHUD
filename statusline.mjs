#!/usr/bin/env node
/**
 * Claude statusline launcher (self-contained).
 *
 * Loads the bundled renderer from ./src/hud/index.js with no external
 * dependency. Before loading, installs an HTTPS_PROXY CONNECT tunnel so the
 * usage/rate-limit API calls work behind a proxy (no-op when no proxy is set).
 *
 * Keep this file free of `?.` / `??` and `node:` import specifiers: it must
 * still load on a Node too old for the renderer (12.x; `node:` in ESM needs
 * 14.13.1), so the version check below can say so.
 */
import { existsSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// `https`, `http` and `tls` load only when a proxy is set: on Node 22+ the ESM
// namespace of `node:http` pulls in undici, ~25 ms on every render (measured).
// createRequire returns the same CJS module object the HUD's own `https` is,
// so the patch below still covers it. No `node:` prefix: require() accepts it
// only from Node 14.18.
const require = createRequire(import.meta.url);

// The documented floor (package.json `engines`). Older Nodes are not refused —
// most of a render may still work — but a load failure says why.
const MIN_NODE = [14, 17];
function nodeTooOld() {
  const parts = String(process.versions.node).split(".").map(Number);
  return parts[0] < MIN_NODE[0] || (parts[0] === MIN_NODE[0] && parts[1] < MIN_NODE[1]);
}
const NODE_FLOOR_NOTE = `Node >=${MIN_NODE.join(".")} required (found ${process.version})`;

function debug(message) {
  if (process.env.HUD_DEBUG) console.error(`[HUD] ${message}`);
}

/**
 * Parse a proxy env value the way curl reads it: a bare `host:port` means
 * `http://host:port`. Returns null — no tunnel — for an unparsable value or a
 * scheme the tunnel cannot speak (socks*), with a HUD_DEBUG note either way.
 */
function parseProxyUrl(value) {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    debug(`ignoring unparsable proxy URL: ${value}`);
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    debug(`ignoring ${url.protocol} proxy (only http:// and https:// proxies can tunnel)`);
    return null;
  }
  return url;
}

/**
 * NO_PROXY / no_proxy, curl-style: comma- or space-separated entries, each `*`
 * (everything), a host, or a domain (`example.com` and `.example.com` both
 * cover its subdomains), optionally with `:port`. No CIDR: the only host the
 * HUD ever calls is api.anthropic.com.
 */
function bypassesProxy(host, port) {
  const list = process.env.NO_PROXY || process.env.no_proxy || "";
  const name = String(host).toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  for (const raw of list.split(/[\s,]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    // `[v6]:port`, `host:port`; a bare IPv6 literal has several colons and no port.
    let entryPort = null;
    const hostPort = /^\[([^\]]*)\](?::(\d+))?$/.exec(entry) || /^([^:]*):(\d+)$/.exec(entry);
    if (hostPort) {
      entry = hostPort[1];
      entryPort = hostPort[2] || null;
    }
    entry = entry.replace(/^\*?\./, "").replace(/\.$/, "");
    if (!entry) continue;
    if (entryPort !== null && entryPort !== String(port)) continue;
    if (name === entry || name.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/**
 * Route https.request through HTTPS_PROXY / https_proxy via a CONNECT tunnel,
 * using only Node built-ins. Patches the shared `node:https` module object, so
 * the dynamically-imported HUD (which calls https.request) is covered. Does
 * nothing unless a proxy env var is set.
 *
 * Handles the two things a corporate proxy commonly needs: credentials in the
 * URL (`http://user:pass@proxy:3128`) are sent as `Proxy-Authorization`, and
 * an `https://` proxy is reached over TLS. A CONNECT that is not answered with
 * 200 (407 auth, 403 policy) fails the request outright instead of starting a
 * TLS handshake on a socket that carries the proxy's error page. A host that
 * NO_PROXY / no_proxy covers goes direct, as it does for Claude Code itself.
 */
function installProxyTunnel() {
  const proxyEnv = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxyEnv) return;
  const proxyUrl = parseProxyUrl(proxyEnv.trim());
  if (!proxyUrl) return;
  const https = require("https");
  const http = require("http");
  const tls = require("tls");
  const origRequest = https.request.bind(https);
  const proxyIsTls = proxyUrl.protocol === "https:";
  // URL keeps an IPv6 literal bracketed ("[::1]"); a socket wants it bare.
  const proxyHost = proxyUrl.hostname.replace(/^\[|\]$/g, "");
  const proxyPort = parseInt(proxyUrl.port, 10) || (proxyIsTls ? 443 : 80);
  // URL parsing keeps userinfo percent-encoded; decode before base64-ing.
  const decode = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const proxyHeaders = {};
  if (proxyUrl.username || proxyUrl.password) {
    const userinfo = `${decode(proxyUrl.username)}:${decode(proxyUrl.password)}`;
    proxyHeaders["Proxy-Authorization"] = `Basic ${Buffer.from(userinfo).toString("base64")}`;
  }

  class HttpsProxyAgent extends https.Agent {
    createConnection(options, callback) {
      const host = options.hostname || options.host;
      const target = `${host}:${options.port || 443}`;
      const connect = proxyIsTls ? origRequest : http.request;
      // Bound the CONNECT handshake. The outer request's own timeout only
      // arms once it has a socket, which a proxy that accepts the TCP
      // connection and never answers would withhold forever — and with it
      // the whole render (reproduced: the process hung until killed).
      const timeout = options.timeout > 0 ? options.timeout : 10000;
      const tunnel = connect({
        hostname: proxyHost,
        port: proxyPort,
        method: "CONNECT",
        path: target,
        headers: { Host: target, ...proxyHeaders },
        timeout,
      });
      tunnel.once("timeout", () => {
        // destroy(err) surfaces through the "error" listener below, once.
        tunnel.destroy(new Error(`proxy CONNECT to ${target} timed out after ${timeout} ms`));
      });
      tunnel.once("connect", (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          callback(new Error(`proxy CONNECT to ${target} failed: HTTP ${res.statusCode}`));
          return;
        }
        // The handshake bound must not outlive the handshake: this raw socket
        // now carries the TLS session, whose idle limit is the outer request's.
        socket.setTimeout(0);
        const tlsSock = tls.connect({
          socket,
          servername: host,
          rejectUnauthorized: options.rejectUnauthorized !== false,
        });
        callback(null, tlsSock);
      });
      tunnel.once("error", callback);
      tunnel.end();
    }
  }

  const agent = new HttpsProxyAgent({ keepAlive: false });

  https.request = function proxyTunnelRequest(urlOrOpts, optsOrCb, cb) {
    let opts;
    if (typeof urlOrOpts === "string" || urlOrOpts instanceof URL) {
      const u = typeof urlOrOpts === "string" ? new URL(urlOrOpts) : urlOrOpts;
      opts = typeof optsOrCb === "function" ? {} : (optsOrCb || {});
      opts = { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, ...opts };
      cb = typeof optsOrCb === "function" ? optsOrCb : cb;
    } else {
      opts = urlOrOpts || {};
      cb = typeof optsOrCb === "function" ? optsOrCb : cb;
    }
    if (bypassesProxy(opts.hostname || opts.host || "localhost", opts.port || 443)) {
      return origRequest(urlOrOpts, optsOrCb, cb);
    }
    if (!opts.agent) opts = { ...opts, agent };
    return origRequest(opts, cb);
  };
}

async function main() {
  const tooOld = nodeTooOld();
  if (tooOld) debug(`${NODE_FLOOR_NOTE}; rendering anyway`);
  installProxyTunnel();

  const entry = join(__dirname, "src", "hud", "index.js");
  if (!existsSync(entry)) {
    console.log(`[HUD] renderer not found at ${entry}`);
    return;
  }
  try {
    await import(pathToFileURL(entry).href);
  } catch (error) {
    const detail = error && typeof error.message === "string" ? error.message : String(error);
    // On a too-old Node the detail is a bare SyntaxError ("Unexpected token
    // '.'") that never names the cause.
    console.log(tooOld ? `[HUD] ${NODE_FLOOR_NOTE}` : `[HUD] load failed: ${detail}`);
    if (tooOld) console.error(`[HUD] load failed: ${detail}`);
  }
}

main();
