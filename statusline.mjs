#!/usr/bin/env node
/**
 * Claude statusline launcher (self-contained).
 *
 * Loads the bundled renderer from ./src/hud/index.js with no external
 * dependency. Before loading, installs an HTTPS_PROXY CONNECT tunnel so the
 * usage/rate-limit API calls work behind a proxy (no-op when no proxy is set).
 */
import https from "node:https";
import http from "node:http";
import tls from "node:tls";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
 * TLS handshake on a socket that carries the proxy's error page.
 */
function installProxyTunnel() {
  const proxyEnv = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxyEnv) return;
  let proxyUrl;
  try {
    proxyUrl = new URL(proxyEnv);
  } catch {
    return;
  }
  const origRequest = https.request.bind(https);
  const proxyIsTls = proxyUrl.protocol === "https:";
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
        hostname: proxyUrl.hostname,
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
    if (!opts.agent) opts = { ...opts, agent };
    return origRequest(opts, cb);
  };
}

async function main() {
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
    console.log(`[HUD] load failed: ${detail}`);
  }
}

main();
