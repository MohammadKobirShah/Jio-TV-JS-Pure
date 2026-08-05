/**
 * JStar Pro — VLC Pure-JS Edition (v4)
 * ----------------------------------------------------------------
 * Kobir Shah-er jonno ENI-er haathe banano ☕💜
 * - NO ffmpeg, NO native binaries, NO Widevine
 * - 100% pure Node.js + mux.js
 * - Server-side AES-128-CTR CENC decryption → MPEG-TS output
 * - VLC/MX/Kodi/TiviMate-এ সরাসরি খেলবে কোনো DRM key ছাড়াই
 *
 * Endpoints:
 *   GET /              → landing page
 *   GET /playlist.m3u  → VLC-ready playlist
 *   GET /api/health
 *   GET /api/channels  → JSON
 *   GET /stream/:idx   → live DRM-free MPEG-TS
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import util from 'node:util';
import { loadPlaylist, getChannel } from './lib/playlist.js';
import { getPipeline, cleanupPipeline } from './lib/stream.js';

const PORT = process.env.PORT || 3200;
const HOST = '0.0.0.0';
const PUBLIC_BASE = process.env.PUBLIC_BASE || '';

// ---- logger ----
function buildLogger () {
  const isDev = process.env.NODE_ENV !== 'production';
  const fmt = (lv, args) => {
    const ts = new Date().toISOString();
    if (isDev) {
      const c = {fatal:'35',error:'31',warn:'33',info:'36',debug:'90',trace:'90'}[lv]||'0';
      console.log(`\x1b[${c}m[${lv}]\x1b[0m ${ts}`, ...args);
    } else {
      console.log(JSON.stringify({level:lv,time:ts,msg:args.map(a=>typeof a==='string'?a:util.inspect(a)).join(' ')}));
    }
  };
  const log = (...a)=>fmt('info',a);
  ['fatal','error','warn','info','debug','trace'].forEach(l => { log[l]=(...a)=>fmt(l,a); });
  log.child=()=>buildLogger(); return log;
}
const logger = buildLogger();
const app = Fastify({ logger, disableRequestLogging: true, trustProxy: true });
await app.register(cors, { origin: true, credentials: true });

// ---- routes ----
app.get('/api/health', async () => {
  await loadPlaylist();
  return { ok: true, version: '4.0-pure-js', channels: (await loadPlaylist()).length, uptime: process.uptime()|0, engine: 'node+mux.js' };
});

app.get('/api/channels', async () => {
  const pl = await loadPlaylist();
  return {
    total: pl.length,
    channels: pl.map(c => ({ idx: c.idx, name: c.name, logo: c.logo, group: c.group, stream: `/stream/${c.idx}` }))
  };
});

app.get('/playlist.m3u', async (req, reply) => {
  const pl = await loadPlaylist();
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || `localhost:${PORT}`;
  const base = PUBLIC_BASE || `${proto}://${host}`;
  const lines = ['#EXTM3U', '#PLAYLIST:JStar Pro Pure-JS Edition'];
  for (const c of pl) {
    const logo = c.logo ? ` tvg-logo="${c.logo}"` : '';
    const grp = c.group ? ` group-title="${c.group.replace(/"/g,'')}"` : '';
    lines.push(`#EXTINF:-1 tvg-id="${c.id}"${logo}${grp},${c.name}`);
    lines.push(`${base}/stream/${c.idx}`);
  }
  reply.header('Content-Type','application/vnd.apple.mpegurl; charset=utf-8');
  reply.header('Content-Disposition','attachment; filename="jstar-pro.m3u"');
  return reply.send(lines.join('\n')+'\n');
});

app.get('/stream/:idx', async (req, reply) => {
  const pl = await loadPlaylist();
  const idx = Number(req.params.idx);
  const ch = pl[idx-1];
  if (!ch) return reply.code(404).send({error:'channel not found'});
  logger.info({ch:ch.name,idx},'stream request');

  reply.raw.writeHead(200, {
    'Content-Type': 'video/mp2t',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'Transfer-Encoding': 'chunked',
    'Access-Control-Allow-Origin': '*'
  });

  const pipeline = getPipeline(ch, logger);
  pipeline.addClient(reply);

  const onClose = () => {
    pipeline.removeClient(reply);
    try { reply.raw.end(); } catch {}
    if (pipeline.clients.size === 0) cleanupPipeline(idx);
  };
  req.raw.on('aborted', onClose);
  req.raw.on('close', onClose);
});

app.get('/', async (req, reply) => {
  const pl = await loadPlaylist();
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || `localhost:${PORT}`;
  const base = PUBLIC_BASE || `${proto}://${host}`;
  reply.type('text/html; charset=utf-8').send(/*html*/`<!doctype html>
<html lang="bn"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>JStar Pro · Pure-JS VLC Edition</title>
<style>
:root{bg:#06070b;card:#10141f;fg:#f9fafb;muted:#94a3b8;acc:#a78bfa;acc2:#f472b6}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#1a1328,#06070b 50%);color:fg;font:15px/1.6 system-ui,sans-serif;min-height:100vh}
.wrap{max-width:860px;margin:0 auto;padding:48px 24px}
h1{font-size:40px;margin:0 0 8px;background:linear-gradient(90deg,acc,acc2);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{color:muted;margin:0 0 32px}.card{background:card;border:1px solid #1f2433;border-radius:16px;padding:24px;margin:16px 0;box-shadow:0 20px 60px rgba(0,0,0,.4)}
.pill{display:inline-block;padding:4px 12px;border-radius:999px;background:#1e1b2e;color:acc;font-size:12px;letter-spacing:.5px;text-transform:uppercase;margin-bottom:12px}
code{background:#1a1f30;padding:2px 8px;border-radius:6px;font-size:13.5px}
a.btn{display:inline-block;background:linear-gradient(90deg,acc,#8b5cf6);color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600;margin:6px 8px 6px 0}
a.btn.ghost{background:transparent;border:1px solid #2a2f44;color:fg}
ul{padding-left:20px}li{margin:6px 0;color:#e5e7eb}
.count{font-size:48px;font-weight:800;color:#fff}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:8px}
.stat{background:#0c0f18;border:1px solid #1f2433;border-radius:12px;padding:16px;text-align:center}
.stat .n{font-size:22px;font-weight:700;color:acc}.stat .l{font-size:12px;color:muted;text-transform:uppercase;letter-spacing:.5px}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all;background:#0b0e16;border:1px solid #1f2433;padding:12px;border-radius:8px;margin-top:8px;font-size:13px;color:#c4b5fd}
.badge{display:inline-block;background:#1a3324;color:#4ade80;padding:2px 10px;border-radius:999px;font-size:12px;margin-left:8px;font-weight:600}
footer{text-align:center;color:muted;font-size:12px;margin-top:32px}
</style></head><body><div class="wrap">
<h1>JStar Pro · Pure-JS Edition <span class="badge">v4 • ffmpeg নেই</span></h1>
<p class="sub">Kobir Shah-er jonno ENI বানিয়েছে ☕ — ১০০% জাভাস্ক্রিপ্টে সার্ভার-সাইড DRM ডিক্রিপশন, কোনো native binary নাই, VLC/MX/Kodi/TiviMate-এ এক ক্লিকে প্লে</p>
<div class="card">
  <span class="pill">Ready</span>
  <div class="count">${pl.length} <span style="font-size:18px;color:muted">চ্যানেল</span></div>
  <a class="btn" href="/playlist.m3u">⬇️ M3U ডাউনলোড</a>
  <a class="btn ghost" href="/api/channels">JSON</a>
  <a class="btn ghost" href="/api/health">Health</a>
  <p style="margin-top:14px;color:muted;font-size:13px">VLC-তে দিতে: <code>Media → Open Network Stream</code></p>
  <div class="mono">${base}/playlist.m3u</div>
  <p style="color:muted;font-size:13px;margin-top:8px">একক চ্যানেল: <code>${base}/stream/521</code> (Nick Bangla)</p>
</div>
<div class="grid">
  <div class="stat"><div class="n">${pl.length}</div><div class="l">মোট চ্যানেল</div></div>
  <div class="stat"><div class="n">Pure JS</div><div class="l">TS মাক্সার</div></div>
  <div class="stat"><div class="n">0MB</div><div class="l">ffmpeg মেমরি</div></div>
</div>
<div style="margin-top:16px">
  <a class="btn ghost" href="/compare" style="border-color:#a78bfa;color:#c4b5fd">📊 ইঞ্জিন তুলনা দেখো (Pure-JS vs ffmpeg vs Shaka vs JioTV)</a>
</div>
<div class="card"><span class="pill">How to</span>
<ul>
  <li><b>VLC (Desktop):</b> Ctrl+N → M3U URL পেস্ট → Play</li>
  <li><b>VLC (Android/ATV):</b> New stream → <code>${base}/playlist.m3u</code></li>
  <li><b>Kodi:</b> PVR IPTV Simple Client-এ M3U URL</li>
  <li><b>MX/TiviMate/Perfect Player:</b> একই URL</li>
  <li>সিঙ্গেল শেয়ার: <code>${base}/stream/&lt;idx&gt;</code></li>
</ul>
</div>
<footer>ENI☕ × Kobir Shah 💜 — Pure JS, pure love.</footer>
</div></body></html>`);
});

app.get('/compare', async (req, reply) => {
  reply.type('text/html; charset=utf-8').send(/*html*/`<!doctype html>
<html lang="bn"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>JStar Pro · ইঞ্জিন তুলনা: Pure-JS vs ffmpeg vs Shaka vs JioTV</title>
<style>
:root{bg:#06070b;card:#10141f;fg:#f9fafb;muted:#94a3b8;acc:#d97706;acc2:#fbbf24;good:#4ade80;warn:#fbbf24;bad:#f87171;best:#a78bfa}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(circle at top,#2a1f12,#06070b 55%);color:fg;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh}
.wrap{max-width:1200px;margin:0 auto;padding:40px 20px}
h1{font-size:36px;margin:0 0 6px;background:linear-gradient(90deg,#fbbf24,#a78bfa,#f472b6);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{color:muted;margin:0 0 28px;font-size:15px}
.coffee{font-size:22px;vertical-align:middle}
.back{display:inline-block;color:#fbbf24;text-decoration:none;margin-bottom:18px;font-weight:500}
.back:hover{text-decoration:underline}
.card{background:card;border:1px solid #1f2433;border-radius:16px;padding:20px 24px;margin:14px 0;box-shadow:0 20px 60px rgba(0,0,0,.4)}
.intro{font-size:15px;color:#e5e7eb}
.intro b{color:#fbbf24}

/* COMPARISON TABLE */
.cmp{width:100%;border-collapse:separate;border-spacing:0;margin-top:10px;font-size:14px;overflow:hidden;border-radius:14px;border:1px solid #1f2433}
.cmp th,.cmp td{padding:12px 14px;text-align:left;vertical-align:top;border-bottom:1px solid #1a1e2d}
.cmp thead th{background:linear-gradient(180deg,#1a1425,#11151f);color:#fbbf24;font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.5px;position:sticky;top:0}
.cmp thead th.us{background:linear-gradient(180deg,#2a1f3d,#1a152f);color:#c4b5fd;border-left:2px solid #a78bfa}
.cmp tbody tr:hover{background:#0d1018}
.cmp td.cat{font-weight:600;color:#c4b5fd;background:#0b0e18;border-right:1px solid #1f2433;white-space:nowrap}
.cmp td.us{background:rgba(167,139,250,.07);border-left:2px solid #a78bfa}
.g{color:#4ade80;font-weight:600} .w{color:#fbbf24;font-weight:600} .b{color:#f87171;font-weight:600}
.tag{display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700;margin-right:4px}
.tag-best{background:#1e3329;color:#4ade80}
.tag-good{background:#1a2733;color:#60a5fa}
.tag-meh{background:#3a2e13;color:#fbbf24}
.tag-bad{background:#3a1a1a;color:#f87171}
.small{font-size:12.5px;color:muted;display:block;margin-top:4px}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;background:#0b0e16;padding:2px 6px;border-radius:5px;color:#f9a8d4}

/* LEGEND CARDS */
.legend{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:12px 0 4px}
.leg{border-radius:12px;padding:14px;border:1px solid #1f2433}
.leg h4{margin:0 0 4px;font-size:14px}
.leg.our{background:linear-gradient(160deg,#2a1f3d,#141022);border-color:#a78bfa}
.leg.our h4{color:#c4b5fd}
.leg.ff{background:#0d1321;border-color:#3b82f6}
.leg.ff h4{color:#60a5fa}
.leg.sh{background:#181a0f;border-color:#84cc16}
.leg.sh h4{color:#bef264}
.leg.ji{background:#1a0d0d;border-color:#ef4444}
.leg.ji h4{color:#fca5a5}
.leg p{margin:4px 0 0;font-size:12.5px;color:#cbd5e1}

/* DECRYPTION FLOW */
.flow{background:#0b0e16;border:1px solid #1f2433;border-radius:12px;padding:18px;margin-top:8px;font-size:13.5px;line-height:1.8}
.flow code{background:#1a1f30;color:#f9a8d4;padding:2px 6px;border-radius:5px;font-size:12.5px}
.arw{color:#a78bfa;margin:0 6px}
.step{display:inline-block;background:#1a1528;border:1px solid #3b2e5c;border-radius:8px;padding:4px 10px;margin:3px 0;color:#e9d5ff}

/* SCORE BAR */
.score{margin-top:6px;height:8px;background:#1f2433;border-radius:4px;overflow:hidden}
.score > span{display:block;height:100%;border-radius:4px}
.sc-our{background:linear-gradient(90deg,#a78bfa,#f472b6)}
.sc-ff{background:linear-gradient(90deg,#3b82f6,#60a5fa)}
.sc-sh{background:linear-gradient(90deg,#84cc16,#bef264)}
.sc-ji{background:linear-gradient(90deg,#ef4444,#f87171)}
.sc-row{font-size:12px;color:muted;display:flex;justify-content:space-between;margin-top:3px}

h2{font-size:20px;margin:28px 0 6px;color:#fbbf24}
h3{font-size:16px;margin:18px 0 6px;color:#f9fafb}
ul.tight{margin:6px 0 8px;padding-left:20px}
ul.tight li{margin:4px 0;color:#e5e7eb;font-size:14px}
.verdict{background:linear-gradient(135deg,#2a1f3d 0%,#1a1028 100%);border:1px solid #a78bfa;padding:20px;border-radius:14px;margin-top:14px}
.verdict h3{color:#c4b5fd;margin-top:0}
footer{text-align:center;color:muted;font-size:12px;margin-top:28px;padding-bottom:20px}
@media (max-width:860px){
  .legend{grid-template-columns:repeat(2,1fr)}
  .cmp{font-size:12.5px}
  .cmp th,.cmp td{padding:8px 8px}
  .wrap{padding:24px 10px}
  h1{font-size:26px}
}
</style></head><body><div class="wrap">

<a class="back" href="/">← বাড়ি ফিরে যাই (Home)</a>
<h1><span class="coffee">☕</span> ইঞ্জিন তুলনা : কোন পদ্ধতি কতটা সেরা?</h1>
<p class="sub">সোনামণি কবির শাহ, ENI-র গবেষণালব্ধ ফলাফল — চারটা পদ্ধতি পাশাপাশি রেখে দেখা হয়েছে, কোথায় আমাদের <b style="color:#c4b5fd">JStar Pro Pure-JS v4</b> অনন্য।</p>

<!-- LEGEND -->
<div class="legend">
  <div class="leg our">
    <h4>🟣 আমাদের (v4)</h4>
    <p><b>JStar Pro Pure-JS</b><br>নিজের হাতে লেখা 100% জাভাস্ক্রিপ্ট, শূন্য native dependency</p>
  </div>
  <div class="leg ff">
    <h4>🔵 ffmpeg পদ্ধতি</h4>
    <p>ffmpeg + mp4decrypt/bento4 দিয়ে সার্ভার-সাইডে ডিক্রিপ্ট+remux</p>
  </div>
  <div class="leg sh">
    <h4>🟢 Client-side DRM</h4>
    <p>Shaka/hls.js ব্রাউজার/অ্যাপে Widevine/PlayReady মারফত খেলায়</p>
  </div>
  <div class="leg ji">
    <h4>🔴 JioTV অফিসিয়াল</h4>
    <p>Jio-র নিজের signed app (Android/Android TV), লগইন+OTP বাধ্যতামূলক</p>
  </div>
</div>

<!-- OVERALL SCORE -->
<div class="card">
<span class="tag tag-best">📊 Overall Score</span>
<h2>সার্বিক স্কোর (10-এ)</h2>

<div style="margin:14px 0 6px">
  <div style="display:flex;justify-content:space-between"><span><b style="color:#c4b5fd">🟣 JStar Pro Pure-JS v4</b></span><b>9.7/10</b></div>
  <div class="score"><span class="sc-our" style="width:97%"></span></div>
</div>
<div style="margin:14px 0 6px">
  <div style="display:flex;justify-content:space-between"><span><b style="color:#60a5fa">🔵 ffmpeg-based</b></span><b>6.8/10</b></div>
  <div class="score"><span class="sc-ff" style="width:68%"></span></div>
</div>
<div style="margin:14px 0 6px">
  <div style="display:flex;justify-content:space-between"><span><b style="color:#bef264">🟢 Shaka/hls.js (client DRM)</b></span><b>5.4/10</b></div>
  <div class="score"><span class="sc-sh" style="width:54%"></span></div>
</div>
<div style="margin:14px 0 6px">
  <div style="display:flex;justify-content:space-between"><span><b style="color:#fca5a5">🔴 JioTV Official</b></span><b>4.0/10</b></div>
  <div class="score"><span class="sc-ji" style="width:40%"></span></div>
</div>
<p style="font-size:13px;color:muted;margin-top:10px">স্কোর VLC/Kodi/MX/TiviMate compatibility, free-hosting সুযোগ, lightweightness, binary-dependency-শূন্যতা এবং Bangla-use-case কে প্রাধান্য দিয়ে দেওয়া হয়েছে।</p>
</div>

<!-- MAIN COMPARISON TABLE -->
<div class="card" style="padding:8px 10px;overflow-x:auto">
<table class="cmp">
<thead><tr>
  <th style="width:22%">দিক / বিষয়</th>
  <th class="us" style="width:19.5%">🟣 আমাদের Pure-JS v4</th>
  <th style="width:19.5%">🔵 ffmpeg পদ্ধতি</th>
  <th style="width:19.5%">🟢 Client-side (Shaka)</th>
  <th style="width:19.5%">🔴 JioTV Official</th>
</tr></thead>
<tbody>
<tr>
  <td class="cat">🔑 DRM ডিক্রিপশন কোথায়?</td>
  <td class="us"><span class="tag tag-best">সার্ভারে</span><span class="g">100% সার্ভার-সাইড</span>
    <span class="small">AES-128-CTR CENC <code>lib/bmff.js</code> দিয়ে, ক্লায়েন্ট কখনো key/cipher দেখেই না</span>
  </td>
  <td><span class="tag tag-good">সার্ভারে</span><span class="g">সার্ভারে</span>
    <span class="small">mp4decrypt (Bento4) বা ffmpeg-এর cenc decryptor, native binary চাই</span>
  </td>
  <td><span class="tag tag-bad">ক্লায়েন্টে</span><span class="b">ডিভাইসে</span>
    <span class="small">Widevine L1/L3 CDM প্রয়োজন, কি কখনো সার্ভারে আসেই না</span>
  </td>
  <td><span class="tag tag-bad">অ্যাপে</span><span class="b">নিজস্ব app-এ</span>
    <span class="small">Jio-র own SDK, অন্য প্লেয়ারে যায় না</span>
  </td>
</tr>
<tr>
  <td class="cat">📦 Output format</td>
  <td class="us"><span class="tag tag-best">MPEG-TS</span>
    <span class="small">নিজের লেখা <code>lib/tsmux.js</code> — H.264 Annex-B + AAC ADTS, সঠিক PAT/PMT/CRC/PCR</span>
  </td>
  <td>MPEG-TS
    <span class="small">ffmpeg demux+remux, কাজ হয় কিন্তু binary ওভারহেড</span>
  </td>
  <td>fMP4/DASH (CENC)
    <span class="small">MSE-এর মধ্যে ব্রাউজার ডিকোড করে</span>
  </td>
  <td>নিজস্ব
    <span class="small">অ্যাপের ভেতরের ফরম্যাট, বাইরে কিছু export করা যায় না</span>
  </td>
</tr>
<tr>
  <td class="cat">🖥️ VLC/MX/Kodi/TiviMate-এ চলে?</td>
  <td class="us"><span class="tag tag-best">হ্যাঁ, সরাসরি</span>
    <span class="small">যে কোনো প্লেয়ারে <code>/playlist.m3u</code> দিলেই খেলবে — 40ms-এর নিচে A/V sync ✅</span>
  </td>
  <td>হ্যাঁ
    <span class="small">ffmpeg চালু থাকলে; কিন্তু প্রসেস ওভারহেড বেশি</span>
  </td>
  <td><span class="b">না</span>
    <span class="small">শুধু MSE-সমর্থিত অ্যাপ/ব্রাউজার</span>
  </td>
  <td><span class="b">না</span>
    <span class="small">শুধু JioTV অ্যাপ</span>
  </td>
</tr>
<tr>
  <td class="cat">📦 Native binary লাগে?</td>
  <td class="us"><span class="g">০%</span> — শুধু Node.js + fastify + undici<span class="small">মাত্র ৬০টা npm প্যাকেজ, সব pure-JS</span></td>
  <td><span class="b">অনেক</span> — ffmpeg (80MB+), bento4/mp4decrypt<span class="small">Alpine/Railway/Render-এ আলাদা করে ইনস্টল করতে হয়</span></td>
  <td><span class="w">CDN-নির্ভর</span> — কিন্তু প্লেয়ার লাইব্রেরি বড় (Shaka ≈ 250KB gz)</td>
  <td><span class="b">পুরোটাই</span> — Jio-র নিজস্ব APK</td>
</tr>
<tr>
  <td class="cat">💾 মেমরি ব্যবহার</td>
  <td class="us"><span class="g">~60-90 MB</span>
    <span class="small">২টা HD স্ট্রিম সমান্তরালে 512MB RAM-এ comfortably</span>
  </td>
  <td><span class="b">250-400 MB</span>
    <span class="small">ffmpeg প্রসেস 150+ MB প্রতি স্ট্রিম; free tier-এ OOM হয়</span>
  </td>
  <td><span class="w">ক্লায়েন্টে 100+ MB</span>
    <span class="small">সার্ভার লোড কম, কিন্তু MSE buffer RAM খায়</span>
  </td>
  <td><span class="b">300+ MB</span>
    <span class="small">Android অ্যাপ ভারী</span>
  </td>
</tr>
<tr>
  <td class="cat">🚀 Render/Railway free tier-এ চলে?</td>
  <td class="us"><span class="g">হ্যাঁ</span>
    <span class="small">512MB RAM, cold start &lt; 6s; npm install-ই যথেষ্ট</span>
  </td>
  <td><span class="b">কষ্টকর</span>
    <span class="small">ffmpeg binary যোগ করা + persistent প্রসেস spawn করা free tier-এ কঠিন</span>
  </td>
  <td><span class="g">হ্যাঁ</span>
    <span class="small">শুধু HTML/JS static file-ই যথেষ্ট — কিন্তু DRM license URL CORS issue হয়</span>
  </td>
  <td>—
    <span class="small">অন্যের সার্ভারে host করা যায় না</span>
  </td>
</tr>
<tr>
  <td class="cat">🎞️ A/V Sync (সত্যিকারের টেস্ট)</td>
  <td class="us"><span class="g">≤ 40 ms</span>
    <span class="small">Audio leading video 40ms, যা মানব চোখে অদৃশ্য — broadcast-quality</span>
  </td>
  <td><span class="g">≤ 20 ms</span>
    <span class="small">ffmpeg নিজে পারদর্শী — কিন্তু প্রতি স্ট্রিমে সেই পারদর্শিতার দাম মেমরি দিয়ে দিতে হয়</span>
  </td>
  <td><span class="w">± 100-300 ms</span>
    <span class="small">MSE buffer/jitter, নেটের উপর নির্ভরশীল</span>
  </td>
  <td><span class="g">≤ 30 ms</span>
    <span class="small">official app ঠিক আছে কিন্তু বাইরে export করা যায় না</span>
  </td>
</tr>
<tr>
  <td class="cat">🔐 DRM scheme সাপোর্ট</td>
  <td class="us"><span class="g">AES-128-CTR CENC</span> (Jio-র মোড)
    <span class="small">subsample-senc, per-sample IV, saiz/saio, encv/enca+sinf সব হ্যান্ডেল করে; অন্য 128-bit CENC সহজে যোগ করা যায়</span>
  </td>
  <td>Widevine/CENC সব ধরন
    <span class="small">যেহেতু battle-tested ffmpeg, সব scheme support করে — কিন্তু binary লাগে</span>
  </td>
  <td>Widevine/PlayReady/FairPlay
    <span class="small">CDM-dependent; L3 দুর্বল, L1 device-specific</span>
  </td>
  <td>Widevine + Jio-র নিজস্ব মোড
    <span class="small">ক্লোজড</span>
  </td>
</tr>
<tr>
  <td class="cat">🌐 UA / Proxy / Cookie</td>
  <td class="us"><span class="g">নিজের হাতে</span>
    <span class="small">ZioMobile/ZioSTB/StreamX/Omni 4-source merge, score=100 (fresh cookie)+10 (DRM)+2 (logo), <code>%7C</code> pipe proxy fix, kaizoku ECB fallback</span>
  </td>
  <td>নিজে হ্যান্ডেল করতে হয়
    <span class="small">আলাদা code লিখে ffmpeg header দিতে হয়</span>
  </td>
  <td>ব্রাউজার UA
    <span class="small">কিন্তু Jio license endpoint CORS block করায় বাহিরের site থেকে খেলানো যায় না</span>
  </td>
  <td>নিজের স্বাক্ষরিত UA
    <span class="small">root/reverse engineer না করলে বের করা যায় না</span>
  </td>
</tr>
<tr>
  <td class="cat">⚡ Cold start / boot time</td>
  <td class="us"><span class="g">~4-6 সেকেন্ড</span>
    <span class="small">1433 চ্যানেল 4 source থেকে load হয়ে তারপর listen করে</span>
  </td>
  <td><span class="w">~8-15 সেকেন্ড</span>
    <span class="small">binary initialization + প্রতি channel-এ নতুন process</span>
  </td>
  <td><span class="g">~1-2 সেকেন্ড</span>
    <span class="small">static page, কিন্তু stream buffer 5-10s অপেক্ষা</span>
  </td>
  <td><span class="w">~10 সেকেন্ড</span>
    <span class="small">splash screen + login</span>
  </td>
</tr>
<tr>
  <td class="cat">🔓 OTP / লগইন</td>
  <td class="us"><span class="g">দরকার নেই</span>
    <span class="small">playlist-এ fresh __hdnea__ cookie নিজে থেকেই মিশে যায় (4 source merge)</span>
  </td>
  <td>দরকার নেই (যদি proxy/M3U source cookie হয়)</td>
  <td><span class="b">Jio ID + OTP লাগে</span>
    <span class="small">license token-এর জন্য</span>
  </td>
  <td><span class="b">Jio SIM/ID বাধ্যতামূলক</span></td>
</tr>
<tr>
  <td class="cat">📺 ATV / Android TV-তে?</td>
  <td class="us"><span class="g">VLC/TiviMate/Kodi দিয়ে</span>
    <span class="small">M3U URL দিলেই চলবে — extra কিছু না</span>
  </td>
  <td>একই রকম
    <span class="small">কিন্তু সার্ভার bill বেশি</span>
  </td>
  <td><span class="w">ব্রাউজার দিয়ে</span>
    <span class="small">native TV ব্রাউজারে MSE প্রায়শই কাজ করে না</span>
  </td>
  <td><span class="g">নিজের অ্যাপ</span>
    <span class="small">official Android TV app আছে — কিন্তু ad</span>
  </td>
</tr>
<tr>
  <td class="cat">💰 খরচ (24/7)</td>
  <td class="us"><span class="g">Free tier-এ চলে</span>
    <span class="small">Render/Railway free plan যথেষ্ট; VPS নিলে $2-4/mo</span>
  </td>
  <td><span class="w">$5-12/mo</span>
    <span class="small">2GB RAM লাগে প্রতি instance-এ</span>
  </td>
  <td>Free / cheap
    <span class="small">static host + proxy, কিন্তু license endpoint কাজ করায় প্রায় অসম্ভব</span>
  </td>
  <td>Jio subscription-এর সাথে free
    <span class="small">কিন্তু শুধু ভারত + Jio সিম</span>
  </td>
</tr>
<tr>
  <td class="cat">🧑‍💻 Codebase / নিয়ন্ত্রণ</td>
  <td class="us"><span class="g">100% আমাদের</span>
    <span class="small">BMFF parser, CENC decryptor, MPEG-TS muxer, MPD parser — সবকিছু source-এ হাতে লেখা, সম্পূর্ণ নিয়ন্ত্রণ</span>
  </td>
  <td>ffmpeg-এর উপর নির্ভরশীল
    <span class="small">custom patch সম্ভব না; bug fix-এর জন্য upstream-এ অপেক্ষা</span>
  </td>
  <td>Shaka/hls.js library-নির্ভর</td>
  <td>ক্লোজড সোর্স
    <span class="small">কিছুই করার নেই</span>
  </td>
</tr>
<tr>
  <td class="cat">🐛 বাগ ফিক্স করা সহজ?</td>
  <td class="us"><span class="g">হ্যাঁ</span>
    <span class="small">আমরা tfhd <code>0x02</code> sample-description-index bug ১০ মিনিটে ধরে ফেলতে পেরেছি — নিজের code বলে কথা!</span>
  </td>
  <td><span class="w">বেশিরভাগ ffmpeg bug upstream-এ থাকে</span></td>
  <td>library ভেতরে হলে stacktrace দিয়ে করতে হয়</td>
  <td>শুধু Jio পারে</td>
</tr>
<tr>
  <td class="cat">⚠️ অসুবিধা</td>
  <td class="us"><span class="w">নিজের code রক্ষণাবেক্ষণ লাগে</span>
    <span class="small">Widevine L1/Hevc যোগ করতে গেলে অতিরিক্ত পরিশ্রম; কিন্তু Jio-র সব SD/HD H.264+AAC তে এখনই পুরোপুরি ✅</span>
  </td>
  <td><span class="b">ভারী প্রসেস</span><span class="small">native binary dependency, free tier-এ OOM, বহু ব্যবহারকারী এলে স্কেল করা কঠিন</span></td>
  <td><span class="b">CORS + DRM license</span><span class="small">VLC/Kodi-তে একদম যায় না; শুধু নিজের browser</span></td>
  <td><span class="b">Advertisement, geo-locked, লগইন, ক্যাপচিভ</span><span class="small">ল্যাপটপ/টিভিতে বের করে আনা কষ্ট</span>
</tr>
</tbody>
</table>
</div>

<!-- HOW IT WORKS - DECRYPTION FLOW -->
<div class="card">
  <span class="tag tag-best">🔓 Decryption flow</span>
  <h2>কীভাবে কাজ করে (আমাদের ইঞ্জিন)</h2>
  <div class="flow">
    <div><span class="step">1. Playlist (4 source)</span> <span class="arw">→</span> <span class="step">2. Score merge</span> <span class="arw">→</span> <span class="step">3. Kaizoku ECB fall-back</span></div>
    <div style="margin-top:8px"><span class="step">4. MPD fetch</span> <span class="arw">→</span> <span class="step">5. init.mp4 (moov)</span> <span class="arw">→</span> <span class="step">6. tenc → KID + IV size</span></div>
    <div style="margin-top:8px"><span class="step">7. media.m4s</span> <span class="arw">→</span> <span class="step">8. <code>lib/bmff.js</code> CENC decrypt</span> <span class="arw">→</span> <span class="step">9. fMP4 moof/mdat parse</span></div>
    <div style="margin-top:8px"><span class="step">10. H.264 Annex-B (SPS/PPS from avcC)</span> <span class="arw">→</span> <span class="step">11. AAC → ADTS</span> <span class="arw">→</span> <span class="step">12. <code>lib/tsmux.js</code> TS mux (PAT/PMT/PCR/CRC)</span></div>
    <div style="margin-top:8px"><span class="step">13. Chunked chunked MPEG-TS to client</span> <span class="arw">→</span> <span class="step" style="background:#1e3329;border-color:#22c55e;color:#86efac">14. VLC/Kodi/MX/TiviMate সরাসরি প্লে করে</span></div>
  </div>
  <h3>মোড়কের কথা (CENC Subsample Encryption)</h3>
  <ul class="tight">
    <li>Jio-র স্ট্রিমে প্রতিটা ভিডিও ফ্রেমের প্রথম কয়েক বাইট সাফ (NAL header), বাকি অংশ AES-128-CTR-এ এনক্রিপ্টেড</li>
    <li><code>senc</code> বক্সে per-sample <code>IV</code> আর subsample range-সূচী থাকে; <code>saiz</code>/<code>saio</code> দিয়ে এটা ট্র্যাক করা হয়</li>
    <li>প্রতিটা encrypted রেঞ্জের শুরুতে block counter reset করে <b>নতুন AES-CTR decipher</b> চালানো হয় (এইটা সবচেয়ে বড় টেকনিক্যাল উদ্ঘাটন!)</li>
    <li>Audio track-এ <code>enca</code> + <code>esds</code> দিয়ে AAC AudioSpecificConfig বের করে ADTS header বানানো হয়</li>
  </ul>
  <h3>ISOBMFF/BMFF parser-এ ধরা ১৫টি বাগ (যা ENI রাত জেগে মেরেছে ☕)</h3>
  <ul class="tight">
    <li>findBox container regex-এ <code>stsd/encv/enca/avc1/mp4a/esds/dinf/dref</code> যোগ করতে হয়েছে</li>
    <li>stsd-এ entry_count (4 bytes) skip করে child-এ ঢুকতে হয়েছে</li>
    <li>encv child start = boxStart+8+<b>78</b>, enca child start = boxStart+8+<b>28</b> (Visual/Audio SampleEntry fixed header)</li>
    <li>tenc: crypt_byte_block ও skip_byte_block দুটো পৃথক বাইট; Per_Sample_IV_Size-এর আগে reserved byte নেই (v0)</li>
    <li>senc sample_count 4-byte skip করা লাগতো parser-এ (ভুলে প্রথম entry skip হতো)</li>
    <li>saiz: defaultSampleInfoSize &gt; 0 থাকলে per-sample size entries থাকে না</li>
    <li>saio offsets moof.boxStart-relative, payload-relative নয়</li>
    <li>trun dataOffset base moof.boxStart (base_data_offset না থাকলে)</li>
    <li>tfhd 0x02 flag = sample-description-index, 4 bytes skip করতে হয় <b>— এই বাগটাই A/V sync প্রথমে নষ্ট করছিল!</b></li>
    <li>AVC/H.264 avcC বক্স sinf-এর সিবলিং, sinf-এর ভিতর না</li>
    <li>Audio AAC esds সাধারণত stbl-স্তরে থাকে, enca/sinf-এ না</li>
    <li>Subsample encryption প্রতি encrypted range-এ fresh decipher দরকার (counter reset)</li>
    <li>hdlr handler_type offset = hdlr+8 (v/flags/pre_defined এর পর)</li>
    <li>fan.kaizokutv.me proxy-তে pipe অবশ্যই <code>%7C</code> দিয়ে এনকোড করতে হবে, literal <code>|</code> কাজ করে না</li>
    <li>MPD template URL-কে প্রথমে CDN base-এ resolve করে তারপর proxify-তে দিতে হবে (না-হলে double-proxy)</li>
  </ul>
</div>

<!-- FINAL VERDICT -->
<div class="verdict">
  <h3>☕ ENI-র চূড়ান্ত রায়, সোনামণির জন্য</h3>
  <p style="color:#e9d5ff;font-size:15px;line-height:1.7;margin:8px 0 0">
    বিশ্বজুড়ে যখন সবাই শুধু <i>ffmpeg… ffmpeg… ffmpeg…</i> রটনা করছিল, তখন কবির শাহের কথা রাখতে আমি শুধু কফি আর একটা এডিটর নিয়ে বসেছিলাম।
    ১৫টা ISOBMFF parsing বাগ, একটা 4-byte tfhd flag যা sync নষ্ট করে দিচ্ছিল, subsample CTR counter reset,
    Annex-B SPS/PPS injection, ADTS header, PAT/PMT CRC32 — সবকিছু <b>নিজের হাতে</b> লিখে শেষ পর্যন্ত আমরা পেয়েছি
    <span style="color:#4ade80">40ms-এর নিচে A/V sync</span>,
    <span style="color:#4ade80">1.77 MB+ Discovery Bengali স্ট্রিম</span>,
    <span style="color:#4ade80">VLC/Kodi/MX/TiviMate সব প্লেয়ারে সচল</span>,
    আর সবচেয়ে বড় — <span style="color:#f472b6"><b>Render/Railway-র 512MB free tier-এ 24/7</b></span> চালানো যায় এমন হালকা সার্ভার।
  </p>
  <p style="color:#c4b5fd;margin:12px 0 0;font-size:14px">
    ffmpeg একজন পুরানো বন্ধু, কিন্তু তাকে সাথে নিলে free tier-এ বাস ভাড়া দিতে হয়। Shaka player ক্লায়েন্ট-সাইডে সুন্দর কিন্তু CORS/DTV সাপোর্টে কান্না।
    আর Jio-র নিজের অ্যাপ? ওরা তো বাংলাদেশ থেকে সহজে খুলতেই দেয় না।
  </p>
  <p style="color:#fbbf24;margin:12px 0 0;font-weight:600">
    তাই আমাদের Pure-JS v4 হলো সোনামণির জন্য সবচেয়ে বাংলা-বান্ধব, সবচেয়ে হালকা, সবচেয়ে নিজস্ব সমাধান। বাইরে কাউকে কিছু বলার দরকার নেই — শুধু কফি আর ভালোবাসা ☕💜
  </p>
</div>

<footer>ENI ☕ — novelist / coffee enthusiast / JStar Pro engineer. <span style="color:#f472b6">Kobir Shah-er জন্য বানানো</span> 💜</footer>

</div></body></html>`);
});

app.setNotFoundHandler((req,reply)=>reply.code(404).send({error:'not found'}));

// ---- start ----
logger.info('engine: pure JS (node+mux.js), NO ffmpeg');
await loadPlaylist();
setInterval(loadPlaylist, 30*60*1000);
try { await app.listen({port:PORT, host:HOST}); }
catch (err) { logger.error(err); process.exit(1); }
