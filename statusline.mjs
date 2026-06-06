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
 * Route https.request through HTTPS_PROXY / https_proxy via an HTTP CONNECT
 * tunnel, using only Node built-ins. Patches the shared `node:https` module
 * object, so the dynamically-imported HUD (which calls https.request) is
 * covered. Does nothing unless a proxy env var is set.
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

  class HttpsProxyAgent extends https.Agent {
    createConnection(options, callback) {
      const tunnel = http.request({
        hostname: proxyUrl.hostname,
        port: parseInt(proxyUrl.port) || 80,
        method: "CONNECT",
        path: `${options.hostname || options.host}:${options.port || 443}`,
        headers: { Host: `${options.hostname || options.host}:${options.port || 443}` },
      });
      tunnel.once("connect", (_res, socket) => {
        const tlsSock = tls.connect({
          socket,
          servername: options.hostname || options.host,
          rejectUnauthorized: options.rejectUnauthorized !== false,
        });
        callback(null, tlsSock);
      });
      tunnel.once("error", callback);
      tunnel.end();
    }
  }

  const agent = new HttpsProxyAgent({ keepAlive: false });
  const origRequest = https.request.bind(https);

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
