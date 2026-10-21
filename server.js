"use strict";
// Resetombolan – liten server utan beroenden (Node 18+).
// Start: node server.js   →  deltagare: http://servern:8080/   admin: http://servern:8080/admin
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const DIR = __dirname;
const DATA_FILE = process.env.DATA_FILE || path.join(DIR, "tombola-data.json");
const KEY_FILE = path.join(DIR, "admin-key.txt");
const INDEX_FILE = path.join(DIR, "index.html");
const MAX_PEOPLE = 12, MAX_BALLS = 10, MAX_TOTAL = 60;
const ALPH = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // inga O/0/I/1/L

// ---------- adminnyckel ----------
function loadAdminKey() {
  if (process.env.ADMIN_KEY && process.env.ADMIN_KEY.trim()) return process.env.ADMIN_KEY.trim();
  try { const k = fs.readFileSync(KEY_FILE, "utf8").trim(); if (k) return k; } catch { /* skapas nedan */ }
  const k = Array.from({ length: 20 }, () => ALPH[crypto.randomInt(ALPH.length)]).join("");
  fs.writeFileSync(KEY_FILE, k + "\n", { mode: 0o600 });
  return k;
}
const ADMIN_KEY = loadAdminKey();
const ADMIN_HASH = crypto.createHash("sha256").update(ADMIN_KEY).digest();

// ---------- lagring ----------
const fresh = () => ({ lotteryId: null, rev: 0, people: [], phase: "lobby", drawId: null, drawnAt: null, winner: null, history: [] });
let db = fresh();
try { db = Object.assign(fresh(), JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))); } catch { /* ny fil */ }
function save() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE);
}

const totalBalls = () => db.people.reduce((s, p) => s + p.balls, 0);
// Det alla får se: inga namn, inga kulor per person, ingen vinnare.
function publicState() {
  return {
    ready: db.people.length > 0, lotteryId: db.lotteryId, rev: db.rev,
    count: db.people.length, total: totalBalls(), joined: db.people.filter((p) => p.joinedAt).length,
    phase: db.phase, drawId: db.drawId, drawnAt: db.drawnAt, now: Date.now(),
  };
}
function adminState() {
  return {
    ...publicState(),
    people: db.people.map((p) => ({ name: p.name, balls: p.balls, code: p.code, joined: !!p.joinedAt })),
    winner: db.phase === "drawn" ? db.winner : null,
    history: db.history.slice(-40),
  };
}

// ---------- live-uppdatering (Server-Sent Events) ----------
const clients = new Set();
function broadcast() {
  const msg = `event: state\ndata: ${JSON.stringify(publicState())}\n\n`;
  for (const c of clients) c.write(msg);
}
setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 20000).unref();

// ---------- hjälpare ----------
const newCode = () => Array.from({ length: 8 }, () => ALPH[crypto.randomInt(ALPH.length)]).join("");
const fmtCode = (c) => c.slice(0, 4) + "-" + c.slice(4);
const normCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 30);
const ipOf = (req) => String(req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket.remoteAddress || "").trim();

const hits = new Map();
function bucketOf(ip, bucket, windowMs) {
  const k = bucket + "|" + ip, now = Date.now();
  let e = hits.get(k);
  if (!e || now - e.t > windowMs) { e = { t: now, n: 0 }; hits.set(k, e); }
  return e;
}
function limited(ip, bucket, max, windowMs) { const e = bucketOf(ip, bucket, windowMs); e.n++; return e.n > max; }
// Räknar bara misslyckade försök, så att en grupp på samma wifi aldrig spärras av sina egna giltiga koder.
const failedTooOften = (ip) => bucketOf(ip, "me-fail", 60000).n >= 30;
const countFailure = (ip) => { bucketOf(ip, "me-fail", 60000).n++; };
setInterval(() => { const now = Date.now(); for (const [k, e] of hits) if (now - e.t > 15 * 60000) hits.delete(k); }, 60000).unref();

function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 65536) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); } else chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(Object.assign(new Error("bad json"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}
function isAdmin(req) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
  if (!m) return false;
  return crypto.timingSafeEqual(crypto.createHash("sha256").update(m[1].trim()).digest(), ADMIN_HASH);
}
function serveIndex(req, res) {
  fs.readFile(INDEX_FILE, (err, html) => {
    if (err) { res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); return res.end("index.html saknas bredvid server.js"); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    res.end(req.method === "HEAD" ? undefined : html);
  });
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const i = url.pathname.lastIndexOf("/api/");
  const route = i >= 0 ? url.pathname.slice(i + 5).replace(/\/+$/, "") : null;

  if (route === null) {
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Metoden stöds inte." });
    if (/\/favicon\.ico$/.test(url.pathname)) { res.writeHead(204); return res.end(); }
    return serveIndex(req, res);
  }

  if (route === "state" && req.method === "GET") return send(res, 200, publicState());

  if (route === "events" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  // En deltagare visar sin kod och får bara sitt eget resultat tillbaka.
  if (route === "me" && req.method === "POST") {
    const ip = ipOf(req);
    if (failedTooOften(ip)) return send(res, 429, { error: "För många felaktiga koder. Vänta en minut." });
    const body = await readJson(req);
    const code = normCode(body.code);
    const idx = code.length === 8 ? db.people.findIndex((p) => normCode(p.code) === code) : -1;
    if (idx < 0) { countFailure(ip); return send(res, 404, { error: "Koden finns inte i den här dragningen." }); }
    const p = db.people[idx];
    if (!p.joinedAt) { p.joinedAt = Date.now(); save(); broadcast(); }
    return send(res, 200, {
      lotteryId: db.lotteryId, rev: db.rev, name: p.name, balls: p.balls, total: totalBalls(),
      phase: db.phase, drawId: db.drawId,
      won: db.phase === "drawn" && db.winner ? db.winner.index === idx : null,
    });
  }

  if (route === "admin" || route.startsWith("admin/")) {
    if (!isAdmin(req)) {
      if (limited(ipOf(req), "admin", 12, 10 * 60000)) return send(res, 429, { error: "För många försök. Vänta en stund." });
      return send(res, 401, { error: "Fel adminnyckel." });
    }
    if (route === "admin" && req.method === "GET") return send(res, 200, adminState());

    if (route === "admin/people" && req.method === "POST") {
      const body = await readJson(req);
      const list = Array.isArray(body.people) ? body.people : [];
      const people = list.map((p) => ({ name: cleanName(p && p.name), balls: Math.round(Number(p && p.balls)) })).filter((p) => p.name);
      if (people.length < 2 || people.length > MAX_PEOPLE) return send(res, 400, { error: `Skriv in mellan 2 och ${MAX_PEOPLE} namn.` });
      if (people.some((p) => !(p.balls >= 1 && p.balls <= MAX_BALLS))) return send(res, 400, { error: `Varje person kan ha 1–${MAX_BALLS} kulor.` });
      if (new Set(people.map((p) => p.name.toLowerCase())).size !== people.length) return send(res, 400, { error: "Två personer har samma namn. Lägg till en initial." });
      if (people.reduce((s, p) => s + p.balls, 0) > MAX_TOTAL) return send(res, 400, { error: `Högst ${MAX_TOTAL} kulor totalt.` });
      const regen = !!body.regenerate || !db.lotteryId;
      const old = new Map(db.people.map((p) => [p.name.toLowerCase(), p]));
      const used = new Set();
      db.people = people.map((p) => {
        const o = !regen && old.get(p.name.toLowerCase());
        if (o) { used.add(normCode(o.code)); return { name: p.name, balls: p.balls, code: o.code, joinedAt: o.joinedAt || null }; }
        return { name: p.name, balls: p.balls, code: null, joinedAt: null };
      });
      for (const p of db.people) if (!p.code) { let c; do c = newCode(); while (used.has(c)); used.add(c); p.code = fmtCode(c); }
      if (regen) db.lotteryId = crypto.randomBytes(6).toString("hex");
      db.rev += 1; db.phase = "lobby"; db.drawId = null; db.drawnAt = null; db.winner = null;
      save(); broadcast();
      return send(res, 200, adminState());
    }

    // Dragningen sker här: en kula väljs likformigt bland alla kulor.
    if (route === "admin/draw" && req.method === "POST") {
      if (db.people.length < 2) return send(res, 400, { error: "Det behövs minst två deltagare." });
      if (db.phase === "drawn") return send(res, 409, { error: "Dragningen är redan gjord. Starta en ny dragning först." });
      const n = totalBalls();
      let r = crypto.randomInt(n), index = 0;
      while (r >= db.people[index].balls) { r -= db.people[index].balls; index++; }
      db.phase = "drawn"; db.drawId = crypto.randomBytes(8).toString("hex"); db.drawnAt = Date.now();
      db.winner = { index, name: db.people[index].name };
      db.history.push({ drawId: db.drawId, at: db.drawnAt, name: db.people[index].name, balls: db.people[index].balls, total: n });
      db.history = db.history.slice(-100);
      save(); broadcast();
      return send(res, 200, adminState());
    }

    if (route === "admin/reset" && req.method === "POST") {
      db.phase = "lobby"; db.drawId = null; db.drawnAt = null; db.winner = null;
      save(); broadcast();
      return send(res, 200, adminState());
    }
    return send(res, 404, { error: "Okänd adminåtgärd." });
  }
  return send(res, 404, { error: "Okänd adress." });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => { if (!res.headersSent) send(res, e.status || 500, { error: e.status ? "Ogiltig förfrågan." : "Serverfel." }); });
});
server.listen(PORT, HOST, () => {
  console.log(`Resetombolan kör på http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/`);
  console.log(`Admin: /admin   Adminnyckel: ${process.env.ADMIN_KEY ? "(från ADMIN_KEY)" : ADMIN_KEY + "  (sparad i admin-key.txt)"}`);
});
const stop = () => { for (const c of clients) c.end(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
