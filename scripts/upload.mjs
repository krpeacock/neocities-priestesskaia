#!/usr/bin/env node
/**
 * upload.mjs — upload this site to neocities.
 *
 * Strategy:
 *   1. If an API token is available (env NEOCITIES_API_TOKEN, ~/.neocities_token,
 *      or project .neocities.json) → use the neocities JSON API.
 *   2. Otherwise → script Google Chrome via the DevTools Protocol:
 *        launch Chrome with --remote-debugging-port using your real profile,
 *        open neocities.org, grab the CSRF token / or an API token from the
 *        settings page, and upload through the logged-in session.
 *
 * Usage:
 *   node scripts/upload.mjs [--dir <site-dir>] [--dry-run] [--skip-chrome]
 *                           [--keep-chrome] [--port <n>] [-v]
 *
 * The site content lives in ./site; everything else in this repo (scripts,
 * notes, etc.) is never uploaded.
 *
 * No external dependencies (needs Node >= 18).
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const API_BASE = "https://neocities.org/api";
const SITE_URL = "https://neocities.org";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXCLUDE = new Set(["scripts", ".pi", ".git", ".neocities.json", "node_modules", ".DS_Store"]);

// ---------------------------------------------------------------- CLI

const args = process.argv.slice(2);
const flags = {
  dir: path.join(REPO_ROOT, "site"),
  dryRun: false,
  skipChrome: false,
  keepChrome: false,
  port: 9333 + Math.floor(Math.random() * 100),
  verbose: false,
};
for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--dir": flags.dir = path.resolve(args[++i]); break;
    case "--dry-run": flags.dryRun = true; break;
    case "--skip-chrome": flags.skipChrome = true; break;
    case "--keep-chrome": flags.keepChrome = true; break;
    case "--port": flags.port = Number(args[++i]); break;
    case "-v": case "--verbose": flags.verbose = true; break;
    case "-h": case "--help":
      console.log("usage: node scripts/upload.mjs [--dir DIR] [--dry-run] [--skip-chrome] [--keep-chrome] [--port N] [-v]");
      process.exit(0);
    default:
      console.error(`unknown argument: ${args[i]}`);
      process.exit(2);
  }
}
const log = (...a) => console.log("[upload]", ...a);
const dbg = (...a) => flags.verbose && console.log("[debug]", ...a);

// ---------------------------------------------------------------- local scan

async function scanSite(dir) {
  const out = [];
  async function walk(rel) {
    for (const ent of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${dir === "." ? "" : ""}${rel}/${ent.name}` : ent.name;
      const full = path.join(dir, r);
      if (ent.isDirectory()) {
        if (!rel && EXCLUDE.has(ent.name)) continue;
        await walk(r);
      } else if (ent.isFile()) {
        if (!rel && EXCLUDE.has(ent.name)) continue;
        const st = await fs.stat(full);
        out.push({ path: r, size: st.size, mtimeMs: st.mtimeMs, full });
      }
    }
  }
  await walk("");
  return out;
}

// ---------------------------------------------------------------- token

async function resolveToken() {
  if (process.env.NEOCITIES_API_TOKEN) return process.env.NEOCITIES_API_TOKEN.trim();
  for (const p of [path.join(flags.dir, ".neocities.json"), path.join(REPO_ROOT, ".neocities.json")]) {
    if (existsSync(p)) {
      try {
        const j = JSON.parse(await fs.readFile(p, "utf8"));
        if (j.api_token) return j.api_token.trim();
      } catch { /* ignore */ }
    }
  }
  const home = path.join(os.homedir(), ".neocities_token");
  if (existsSync(home)) return (await fs.readFile(home, "utf8")).trim();
  return null;
}

// ---------------------------------------------------------------- API path

async function apiRequest(token, endpoint, { params = {}, body } = {}) {
  const qs = new URLSearchParams(params);
  const url = `${API_BASE}/${endpoint}` + (qs.toString() ? `?${qs}` : "");
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}` },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (data?.result === "error" || data?.error)
    throw new Error(`${endpoint}: ${data.message || JSON.stringify(data.error || data)}`);
  if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function apiListAll(token) {
  const files = [];
  let where = "/";
  do {
    const data = await apiRequest(token, "list", { params: { path: where } });
    files.push(...(data.files || []).filter(f => !f.is_directory));
    where = data.next_uri ? new URL(data.next_uri, "https://x.y").searchParams.get("path") : null;
  } while (where);
  return files;
}

function sha1(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

async function apiUploadFiles(token, entries) {
  // In the current API the multipart field name IS the site-relative path,
  // so we can batch every changed file into a single upload call.
  if (!entries.length) return;
  const fd = new FormData();
  for (const e of entries) {
    const buf = await fs.readFile(e.full);
    fd.append(e.path, new Blob([buf]), path.basename(e.path));
  }
  await apiRequest(token, "upload", { body: fd });
  log(`uploaded ${entries.length} file(s)`);
}

async function apiDeleteFiles(token, paths) {
  if (!paths.length) return;
  const fd = new URLSearchParams();
  for (const p of paths) fd.append("filenames[]", p);
  await apiRequest(token, "delete", { body: fd });
  log(`deleted ${paths.length} file(s): ${paths.join(", ")}`);
}

async function needsUpload(f, r) {
  if (!r) return true;
  if (r.sha1_hash) {
    // exact check when the server provides hashes
    return sha1(await fs.readFile(f.full)) !== r.sha1_hash;
  }
  return r.size !== f.size;
}

async function runApi(token, site, local, remote) {
  const toUpload = [];
  for (const f of local) if (await needsUpload(f, remote.get(f.path))) toUpload.push(f);
  const toDelete = [...remote.keys()].filter(p => !local.some(f => f.path === p) && p !== "index.html");

  if (!toUpload.length && !toDelete.length) { log("up to date, nothing to do"); return; }
  log(`site=${site} uploading=${toUpload.length} deleting=${toDelete.length}`);
  for (const f of toUpload) console.log(`  + ${f.path}`);
  for (const p of toDelete) console.log(`  - ${p}`);
  if (flags.dryRun) return;
  await apiUploadFiles(token, toUpload);
  await apiDeleteFiles(token, toDelete);
}

// ---------------------------------------------------------------- Chrome fallback

const sleep = ms => new Promise(r => setTimeout(r, ms));

function findChrome() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  return candidates.find(p => existsSync(p));
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener("message", ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method === "Target.targetCreated") {
        this.onTargetCreated?.(msg.params);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async evaluate(sessionId, expression) {
    const r = await this.send("Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ||
        r.exceptionDetails.text || "page eval failed");
    }
    return r.result.value;
  }
}

async function connectCDP(port) {
  const listUrl = `http://127.0.0.1:${port}/json/version`;
  let json;
  for (let i = 0; i < 60; i++) {
    try { json = await (await fetch(listUrl)).json(); break; }
    catch { await sleep(500); }
  }
  if (!json) throw new Error("could not reach Chrome DevTools endpoint");
  const ws = new WebSocket(json.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  return new CDP(ws);
}

async function copyProfileLite(src, dst) {
  // Minimal, lock-free files needed to carry over logins.
  // SQLite cookies are safe to copy while Chrome runs (WAL readers don't block).
  await fs.mkdir(path.join(dst, "Default"), { recursive: true });
  const items = [
    "Local State",
    "Default/Cookies", "Default/Cookies-wal", "Default/Cookies-shm",
    "Default/Preferences",
    "Default/Network Persistent State",
    "Default/TransportSecurity",
  ];
  let copied = 0;
  for (const it of items) {
    try { await fs.copyFile(path.join(src, it), path.join(dst, it)); copied++; } catch {}
  }
  dbg(`copied ${copied} profile files to ${dst}`);
  return copied > 0;
}

async function withChrome(fn) {
  const chrome = findChrome();
  if (!chrome) throw new Error("Google Chrome not found — set NEOCITIES_API_TOKEN instead");
  const srcProfile = path.join(os.homedir(), "Library/Application Support/Google/Chrome");
  const tmpProfile = path.join(os.homedir(), ".cache/neocities-upload-chrome-profile");

  let port = flags.port, spawned = null;
  let debuggable = false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    debuggable = r.ok;
  } catch { /* not running with debug port */ }

  if (debuggable) {
    log("reusing existing debuggable Chrome on port", port);
  } else {
    // Chrome 136+ forbids remote debugging on the default profile, so launch a
    // separate instance with a lightweight copy of it (persists across runs,
    // so a manual login in this profile only needs to happen once).
    const firstUse = !existsSync(tmpProfile);
    if (firstUse || process.env.NEOCITIES_REFRESH_PROFILE) {
      log("creating lightweight Chrome profile copy (cookies only)...");
      await fs.rm(tmpProfile, { recursive: true, force: true });
      await copyProfileLite(srcProfile, tmpProfile);
    }
    log("launching Chrome with remote debugging (separate instance, your login copied in)...");
    spawned = spawn(chrome, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${tmpProfile}`,
      "--no-first-run", "--no-default-browser-check",
    ], { stdio: "ignore", detached: true });
    spawned.unref();
  }

  const cdp = await connectCDP(port);
  try {
    // Open a background tab pointing at neocities.
    await cdp.send("Target.createTarget", { url: `${SITE_URL}/sign_in`, background: true });
    const { targetInfos } = await cdp.send("Target.getTargets");
    const target = targetInfos
      .filter(t => t.type === "page" && (t.url || "").startsWith(SITE_URL))
      .sort((a, b) => b.createTime - a.createTime)[0];
    if (!target) throw new Error("could not find neocities tab");
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });

    // wait for page load
    for (let i = 0; i < 40; i++) {
      const ready = await cdp.evaluate(sessionId, "document.readyState").catch(() => null);
      if (ready === "complete") break;
      await sleep(500);
    }
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);
    return await fn(cdp, sessionId, spawned);
  } finally {
    if (spawned && !flags.keepChrome) {
      await cdp.send("Browser.close").catch(() => {});
    }
    try { cdp.ws.close(); } catch {}
    if (spawned && !flags.keepChrome) {
      try { process.kill(-spawned.pid); } catch {}
    }
  }
}

async function chromeLoginStatus(cdp, sessionId) {
  const { cookies } = await cdp.send("Network.getCookies", { urls: [SITE_URL] }, sessionId).catch(() => ({ cookies: [] }));
  if (cookies.some(c => c.name.startsWith("_session"))) return { loggedIn: true };
  const ui = await cdp.evaluate(sessionId, `
    !!document.querySelector('a[href="/sign_out"], #dashboard, a[href="/dashboard"]')`);
  return { loggedIn: !!ui };
}

async function chromeExtractToken(cdp, sessionId) {
  // Try to read (or reveal) the API token from the settings page.
  await cdp.send("Page.navigate", { url: `${SITE_URL}/settings` }, sessionId);
  for (let i = 0; i < 30; i++) {
    const st = await cdp.evaluate(sessionId, "location.pathname").catch(() => "");
    if (st === "/settings") break;
    await sleep(500);
  }
  return cdp.evaluate(sessionId, `(() => {
    const reveal = [...document.querySelectorAll('button,a')].find(b => /reveal|show/i.test(b.textContent||''));
    if (reveal) reveal.click();
    const m = document.body.innerText.match(/API[^\\n]*token[^\\n]*[:\\s]*([a-zA-Z0-9_-]{20,})/i)
      || document.body.innerText.match(/([a-zA-Z0-9_-]{32,})/);
    if (m) return m[1];
    const inp = [...document.querySelectorAll('input')].find(i => /^[a-zA-Z0-9_-]{20,}$/.test(i.value||''));
    return inp ? inp.value : null;
  })()`);
}

async function chromeUploadViaSession(cdp, sessionId, entries) {
  // Upload through the logged-in web session using in-page fetch (cookies + CSRF).
  const csrf = await cdp.evaluate(sessionId, `document.querySelector('meta[name="csrf-param"]')`);
  const csrfToken = await cdp.evaluate(sessionId,
    `(() => { const m = document.querySelector('meta[name="csrf-token"]');
       const i = document.querySelector('input[name$=authenticity_token], input[name=_csrf]');
       return m ? m.content : (i ? i.value : null); })()`);
  const files = [];
  for (const e of entries) files.push({ path: e.path, b64: (await fs.readFile(e.full)).toString("base64") });

  const CHUNK = 10;
  for (let i = 0; i < files.length; i += CHUNK) {
    const batch = files.slice(i, i + CHUNK);
    const result = await cdp.evaluate(sessionId, `(async () => {
      const files = ${JSON.stringify(batch)};
      const fd = new FormData();
      ${csrfToken ? `fd.append(${JSON.stringify(process.env.NEOCITIES_CSRF_FIELD || "authenticity_token")}, ${JSON.stringify(csrfToken)});` : ""}
      for (const f of files) {
        const bin = Uint8Array.from(atob(f.b64), c => c.charCodeAt(0));
        fd.append('file[]', new File([bin], f.path), f.path);
      }
      const res = await fetch('/upload', { method: 'POST', body: fd, credentials: 'same-origin' });
      const text = await res.text();
      return { status: res.status, ok: res.ok, sample: text.slice(0, 300) };
    })()`);
    if (!result.ok) throw new Error(`session upload failed (HTTP ${result.status}): ${result.sample}`);
    log(`uploaded ${Math.min(i + CHUNK, files.length)}/${files.length} via chrome session`);
  }
}

async function runChrome(local, remote) {
  const toUpload = local.filter(f => {
    const r = remote?.get(f.path);
    return !r || r.size !== f.size;
  });
  const toDelete = remote ? [...remote.keys()].filter(p => !local.some(f => f.path === p)) : [];
  log(`uploading=${toUpload.length} deleting=${toDelete.length}`);
  if (flags.dryRun) {
    for (const f of toUpload) console.log(`  + ${f.path}`);
    for (const p of toDelete) console.log(`  - ${p}`);
    return;
  }
  if (!toUpload.length && !toDelete.length) { log("up to date (size-compare only)"); return; }

  await withChrome(async (cdp, sessionId, spawned) => {
    const status = await chromeLoginStatus(cdp, sessionId);
    if (!status.loggedIn) {
      if (spawned) {
        flags.keepChrome = true; // leave the window open so the user can log in
        console.error("\n[upload] The copied session is not logged in to neocities.");
        console.error("[upload] A Chrome window is staying open — log in to neocities.org there,");
        console.error("[upload]      then re-run this script (the login persists in the copied profile).");
        console.error("[upload] Tip: once logged in, copy the API token from neocities.org/settings and");
        console.error("[upload]      save it to ~/.neocities_token to use the fast API path from now on.");
        process.exitCode = 1;
        return;
      }
      throw new Error("not logged in to neocities in the debuggable Chrome instance");
    }
    log("Chrome session is logged in to neocities");

    // Prefer to quietly lift the API token and use the proper API.
    let token = null;
    try { token = await chromeExtractToken(cdp, sessionId); } catch (e) { dbg("token extract failed:", e.message); }
    if (token) {
      log("extracted API token from settings page — using API");
      await fs.writeFile(path.join(os.homedir(), ".neocities_token"), token + "\n", { mode: 0o600 }).catch(() => {});
      const info = await apiRequest(token, "info");
      await runApi(token, info.info?.sitename || "?", local, remote);
      return;
    }

    // Otherwise upload through the browser session itself.
    dbg("no token found, using logged-in web session upload");
    await cdp.send("Page.navigate", { url: `${SITE_URL}/` }, sessionId);
    await sleep(2000);
    await chromeUploadViaSession(cdp, sessionId, toUpload);
    log("done (session upload). deletions require the API — set NEOCITIES_API_TOKEN for delete support.");
  });
}

// ---------------------------------------------------------------- main

async function main() {
  const dir = flags.dir;
  log(`site dir: ${dir}`);
  const local = await scanSite(dir);
  dbg(`local files: ${local.length}`);

  const token = await resolveToken();
  if (token) {
    const info = await apiRequest(token, "info");
    const site = info.info?.sitename;
    if (!site) throw new Error("token not linked to a site");
    log(`API token OK for site "${site}"`);
    const remote = new Map((await apiListAll(token)).map(f => [f.path, f]));
    await runApi(token, site, local, remote);
  } else if (flags.skipChrome) {
    throw new Error("no API token found (NEOCITIES_API_TOKEN / ~/.neocities_token / .neocities.json) and --skip-chrome given");
  } else {
    log("no API token — falling back to Chrome automation");
    await runChrome(local, null);
  }
  log(flags.dryRun ? "dry run complete" : "complete ✔");
}

main().catch(err => { console.error("[upload] ERROR:", err.message); process.exit(1); });
