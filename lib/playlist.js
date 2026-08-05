/**
 * Multi-source playlist loader — Kobir Shah 💜
 * Loads + merges 4 premium M3U/JSON sources, applies smart scoring, and resolves DRM keys.
 * Same parsing/merge proven in v3.3 Lite and VLC Edition.
 */
import { request, Agent } from 'undici';
import { createDecipheriv } from 'node:crypto';

const CONFIG = {
  playlistRefreshSec: 1800,
  upstreamTimeoutMs: 30_000,
  premiumSources: [
    { name: 'ZioMobile M3U', url: 'https://raw.githubusercontent.com/Sflex0719/m3u/refs/heads/main/ZioMobile.m3u',
      format: 'm3u8', ua: 'plaYtv/7.1.5 (StreamFlex;Android 16) JioTvMobile' },
    { name: 'Zio STB M3U', url: 'https://raw.githubusercontent.com/Sflex0719/m3u/refs/heads/main/Zio.m3u',
      format: 'm3u8', ua: 'JioTV.Plus/2.8.4_2076/StreamFlex(StreamFlex;JioSTB) JioTvPlus-AndroidTv' },
    { name: 'StreamX M3U', url: 'https://yashzeotvplus.livenoww.workers.dev/', format: 'm3u8', ua: 'OTT Navigator' },
    { name: 'OmniTV JSON', url: 'https://upaidworker.streamxlive.workers.dev/', format: 'json', ua: 'OTT Navigator' }
  ],
  kaizokuProxy: 'https://fan.kaizokutv.me/prox/jio-prox.php?url=',
  kaizokuPlayer: 'https://kaizokutv.me/jio/player.php?url=',
  kaizokuSecret: Buffer.from('MySuperSecretKey'.padEnd(16, '\0').slice(0,16)),
  licenseUpstream: 'https://ziotvplus.yowaimo.in/license/',
  staticKeyOverrides: {
    'edcb479f1e5b5b4fa263b602faaad9a2': '5df3042f0c01b7cf53ce88d15c0671cd'
  },
  upstreamHeaders: {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9'
  }
};

const httpAgent = new Agent({ connections: 64, keepAliveTimeout: 30_000 });

let playlist = [];
let lastFetch = 0;
const now = () => Date.now();

async function fetchRaw (url, headers = {}, method = 'GET', body) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), CONFIG.upstreamTimeoutMs);
  try {
    const opts = { method, dispatcher: httpAgent, signal: ctrl.signal, headers: { ...CONFIG.upstreamHeaders, ...headers }, maxRedirections: 5 };
    if (body) opts.body = body;
    const r = await request(url, opts);
    if (r.statusCode >= 400) throw new Error(`upstream ${r.statusCode}: ${url.slice(0,120)}`);
    const buf = Buffer.from(await r.body.arrayBuffer());
    return { buffer: buf, ct: r.headers['content-type'] || 'application/octet-stream' };
  } finally { clearTimeout(to); }
}
async function fetchText (url, ua) {
  const h = { ...CONFIG.upstreamHeaders };
  if (ua) h['User-Agent'] = ua;
  return (await fetchRaw(url, h)).buffer.toString('utf8');
}

function b64urlToHex (s) {
  if (/^[0-9a-fA-F]{32}$/.test(s)) return s.toLowerCase();
  try { return Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/')+'==','base64').toString('hex'); } catch { return ''; }
}

function hdneaExpiry (s) {
  if (!s) return 0;
  const m = /__hdnea__=st=\d+~exp=(\d+)/.exec(s);
  return m ? Number(m[1])*1000 : 0;
}
function isFreshCookie (c) { return hdneaExpiry(c) > now() + 30_000; }

function buildProxiedUrl (orig, cookie) {
  if (!orig) return '';
  if (orig.startsWith(CONFIG.kaizokuProxy)) return orig;
  const tok = /__hdnea__=([^\s"'<>|]+)/.exec(cookie || '');
  if (!tok) return CONFIG.kaizokuProxy + encodeURIComponent(orig);
  const token = tok[1];
  const xxx = 'xxx=%7Ccookie=__hdnea__=' + token;
  let u;
  if (orig.includes('__hdnea__=')) u = orig.includes('xxx=') ? orig : orig + '&' + xxx;
  else { const s = orig.includes('?') ? '&' : '?'; u = orig + s + '__hdnea__=' + token + '&' + xxx; }
  return CONFIG.kaizokuProxy + encodeURIComponent(u);
}

function parseM3u (text) {
  const out = [];
  const pending = { drm:'', ua:'', cookie:'', origin:'', referer:'' };
  let cur = null;
  const flush = () => {
    if (!cur) return;
    if (!cur.drm && pending.drm) cur.drm = pending.drm;
    if (!cur.ua && pending.ua) cur.ua = pending.ua;
    if (!cur.cookie && pending.cookie) cur.cookie = pending.cookie;
    if (!cur.referer && pending.referer) cur.referer = pending.referer;
    if (!cur.origin && pending.origin) cur.origin = pending.origin;
    pending.drm=pending.ua=pending.cookie=pending.origin=pending.referer='';
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#EXTM3U')) continue;
    const drmM = /#KODIPROP:\s*inputstream\.adaptive\.license_key=(.+)/i.exec(line);
    const typeM = /#KODIPROP:\s*inputstream\.adaptive\.(manifest_type|license_type)=/i.exec(line);
    if (typeM) continue;
    if (drmM) { const v=drmM[1].trim(); if (!/^clearkey$/i.test(v)) { if (cur) cur.drm=v; else pending.drm=v; } continue; }
    if (line.startsWith('#KODIPROP:')) continue;
    if (line.startsWith('#EXTVLCOPT:') && line.includes('http-user-agent=')) {
      const ua = line.split('http-user-agent=')[1].trim();
      if (cur) cur.ua=ua; else pending.ua=ua; continue;
    }
    if (line.startsWith('#EXTVLCOPT:')) continue;
    if (line.startsWith('#EXTHTTP:')) {
      try {
        const h = JSON.parse(line.slice(9));
        const set = c => { if (h.cookie) c.cookie=h.cookie; if (h.Origin) c.origin=h.Origin; if (h.Referer) c.referer=h.Referer; };
        if (cur) set(cur); else set(pending);
      } catch {}
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      flush();
      const name = line.includes(',') ? line.split(',').slice(-1)[0].trim() : 'Channel';
      const attrs = {};
      for (const a of ['tvg-id','tvg-logo','group-title']) {
        const tok = `${a}="`;
        if (line.includes(tok)) { const s=line.indexOf(tok)+tok.length; const e=line.indexOf('"',s); attrs[a]=line.slice(s,e); }
      }
      cur = { name, ...attrs, drm:'', ua:'', cookie:'', origin:'', referer:'' };
      continue;
    }
    if (line.startsWith('#')) continue;
    if (cur && /^https?:/.test(line)) { cur.url=line; flush(); out.push(cur); cur=null; }
  }
  return out;
}

function parseOmniJson (arr) {
  return arr.map(c => ({
    name: c.name||'', 'tvg-id': String(c.id||''), 'tvg-logo': c.logo||'', 'group-title': c.category||'Uncategorized',
    url: c.url||'', drm: (c.keyId&&c.key)?`${c.keyId}:${c.key}`:'', ua:'OTT Navigator', cookie:c.cookie||'',
    origin:'https://www.jiotv.com/', referer:'https://www.jiotv.com/'
  })).filter(c => c.url);
}

function normalize (c, i) {
  const clearKeys = {};
  let lic = '';
  const drm = (c.drm||'').trim();
  if (drm) {
    if (drm.startsWith('http')) lic = drm;
    else {
      const km = /^([0-9a-fA-F]{32}):([0-9a-fA-F]{32})$/.exec(drm);
      if (km) clearKeys[km[1].toLowerCase()] = km[2].toLowerCase();
      else try {
        const j = JSON.parse(drm);
        if (Array.isArray(j.keys)) for (const k of j.keys) if (k.kid&&k.k) {
          const kh = b64urlToHex(k.kid), vh = b64urlToHex(k.k);
          if (kh&&vh) clearKeys[kh]=vh;
        }
      } catch {}
    }
  }
  const cookie = c.cookie||'';
  const referer = c.referer || (/jiotv|jio\.com/i.test(c.url) ? 'https://www.jiotv.com/' : 'https://www.jiocinema.com/');
  const origin = c.origin || referer.replace(/\/$/,'');
  return {
    id: 'ch_'+(c['tvg-id']||i), idx:i+1, name:c.name||`Channel ${i+1}`, logo:c['tvg-logo']||'',
    group: c['group-title']||'Other',
    url: buildProxiedUrl(c.url||'', cookie),
    rawUrl: c.url||'',
    license_key: lic,
    clearKeys,
    headers: { 'User-Agent': c.ua||CONFIG.upstreamHeaders['User-Agent'], Cookie:cookie, Referer:referer, Origin:origin }
  };
}

// Kaizoku fallback
function aesEcbDecrypt (b64) {
  try {
    const d = createDecipheriv('aes-128-ecb', CONFIG.kaizokuSecret, null);
    d.setAutoPadding(true);
    return Buffer.concat([d.update(Buffer.from(b64,'base64')),d.final()]).toString('utf8');
  } catch { return ''; }
}
const kaizokuCache = new Map();
async function fetchFromKaizoku (tvgId) {
  if (!tvgId) return null;
  const c = kaizokuCache.get(tvgId);
  if (c && c.exp > now()+30_000) return c;
  try {
    const { buffer } = await fetchRaw(CONFIG.kaizokuPlayer+encodeURIComponent(tvgId), {
      'User-Agent':'Mozilla/5.0 Chrome/120 Safari/537.36'
    });
    const html = buffer.toString('utf8');
    const grab = v => {
      const re = new RegExp('var\\s+'+v+'\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*;');
      const m = html.match(re); return m?m[1]:'';
    };
    let s = aesEcbDecrypt(grab('phpEncryptedStream'));
    const kid = aesEcbDecrypt(grab('phpEncryptedKeyId'));
    const key = aesEcbDecrypt(grab('phpEncryptedKey'));
    if (!s) return null;
    for (let i=0;i<3 && !/^https?:\/\//i.test(s);i++) { try { s = decodeURIComponent(s); } catch { break; } }
    const em = /exp=(\d+)/.exec(s);
    const exp = em ? Number(em[1])*1000 : now()+50*60*1000;
    const entry = { url:s, kid, key, exp };
    kaizokuCache.set(tvgId, entry);
    return entry;
  } catch (e) { return null; }
}

export async function resolveFreshKeyAndUrl (ch) {
  // returns { key: Buffer(16), url, kidHex }
  const tvgId = ch.id.startsWith('ch_') ? ch.id.slice(3) : '';
  // 1: kaizoku fresh URL + key first
  if (tvgId) {
    const f = await fetchFromKaizoku(tvgId);
    if (f && f.url) {
      ch.url = f.url;
      if (f.kid && f.key) return { key: Buffer.from(f.key,'hex'), url: f.url, kidHex: f.kid.toLowerCase() };
    }
  }
  // 2: playlist-supplied clearKeys
  if (ch.clearKeys && Object.keys(ch.clearKeys).length) {
    const [kid,key] = Object.entries(ch.clearKeys)[0];
    return { key: Buffer.from(key,'hex'), url: ch.url, kidHex: kid };
  }
  // 3: upstream license proxy
  if (ch.license_key && /^https?:\/\//.test(ch.license_key)) {
    try {
      const { buffer } = await fetchRaw(ch.license_key, {
        'Content-Type':'application/json',
        'User-Agent': ch.headers['User-Agent'],
        'Referer': ch.headers.Referer||'', 'Origin': ch.headers.Origin||''
      }, 'POST', Buffer.from('{"kids":[]}'));
      const j = JSON.parse(buffer.toString());
      if (j.keys && j.keys[0]?.k) {
        const kh=b64urlToHex(j.keys[0].kid), vh=b64urlToHex(j.keys[0].k);
        if (kh&&vh) return { key: Buffer.from(vh,'hex'), url:ch.url, kidHex:kh };
      }
    } catch {}
  }
  // 4: static override
  for (const [kid,key] of Object.entries(CONFIG.staticKeyOverrides)) {
    return { key: Buffer.from(key,'hex'), url:ch.url, kidHex:kid };
  }
  return null;
}

export async function loadPlaylist () {
  if (now()-lastFetch < CONFIG.playlistRefreshSec*1000 && playlist.length) return playlist;
  const start = now();
  const sourceResults = [];
  for (const src of CONFIG.premiumSources) {
    try {
      const text = await fetchText(src.url, src.ua);
      let chs = [];
      if (src.format==='m3u8' || /^#EXTM3U/.test(text.slice(0,64))) chs = parseM3u(text);
      else if (text.trim().startsWith('[') || text.trim().startsWith('{')) {
        const p = JSON.parse(text); chs = Array.isArray(p)?parseOmniJson(p):[];
      }
      sourceResults.push({ name:src.name, chs });
      console.log(`[info] premium source ${src.name}: ${chs.length} channels`);
    } catch (e) { console.error('[error] source failed', src.name, e.message); }
  }
  const sourceRank = { 'ZioMobile M3U':4, 'Zio STB M3U':3, 'StreamX M3U':2, 'OmniTV JSON':1 };
  const score = (ch, sn) => (isFreshCookie(ch.cookie||'')?100:0) + (ch.drm?10:0) + ((ch['tvg-logo']||ch.logo)?2:0) + (sourceRank[sn]||0);
  const byName = new Map();
  for (const r of sourceResults) for (const ch of r.chs) {
    const k = (ch.name||'').trim().toLowerCase();
    if (!k) continue;
    const cur = byName.get(k);
    if (!cur || score(ch,r.name) > score(cur.ch,cur.src)) byName.set(k,{ch,src:r.name});
  }
  const ordered = [], seen = new Set();
  for (const r of sourceResults) for (const ch of r.chs) {
    const k = (ch.name||'').trim().toLowerCase();
    if (k && !seen.has(k)) { seen.add(k); ordered.push(k); }
  }
  const raw = [];
  for (const k of ordered) { const b = byName.get(k); if (b) raw.push(b.ch); }
  playlist = raw.map(normalize);
  lastFetch = now();
  const fresh = playlist.filter(c=>isFreshCookie(c.headers?.Cookie||'')).length;
  console.log(`[info] playlist loaded: ${playlist.length} channels (${fresh} fresh) in ${(now()-start)|0}ms`);
  return playlist;
}

export function getPlaylist () { return playlist; }
export function getChannel (idx) { return playlist[idx-1]; }
