/**
 * JStar Pro — VLC Pure-JS Edition (v4)
 * ----------------------------------------------------------------
 * Kobir Shah-er jonno ENI-er haathe banano ☕💜
 * - NO ffmpeg, NO native binaries, NO Widevine
 * - 100% pure Node.js
 * - Server-side AES-128-CTR CENC decryption → MPEG-TS output
 * - VLC/MX/Kodi/TiviMate-এ সরাসরি খেলবে কোনো DRM key ছাড়াই
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import util from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaylist } from './lib/playlist.js';
import { getPipeline, cleanupPipeline } from './lib/stream.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

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

// ---- Serve dedicated static pages (home + comparison) ----
await app.register(fastifyStatic, {
  root: PUBLIC_DIR,
  serve: false, // we'll serve index/compare manually so URLs stay clean
});

// ---- Clean redirects for old/direct html URLs ----
app.get('/index.html', async (_req, reply) => reply.redirect(301, '/'));
app.get('/compare.html', async (_req, reply) => reply.redirect(301, '/compare'));
app.get('/home', async (_req, reply) => reply.redirect(301, '/'));

// ---- Static HTML pages ----
app.get('/', (_req, reply) => reply.sendFile('index.html'));
app.get('/compare', (_req, reply) => reply.sendFile('compare.html'));

// ---- API ----
app.get('/api/health', async () => {
  const pl = await loadPlaylist();
  return { ok: true, version: '4.0-pure-js', channels: pl.length, uptime: process.uptime()|0, engine: 'node+tsmux' };
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

// ---- Live TS stream ----
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

app.setNotFoundHandler((req,reply)=>reply.code(404).send({error:'not found'}));

// ---- start ----
logger.info('engine: pure JS, NO ffmpeg');
await loadPlaylist();
setInterval(loadPlaylist, 30*60*1000);
try { await app.listen({port:PORT, host:HOST}); }
catch (err) { logger.error(err); process.exit(1); }
