/**
 * Pure-JS live TS pipeline v2 — Kobir Shah Edition ☕
 *
 * Uses our own minimal TS muxer + fMP4 demuxer + H.264/AAC framing.
 * No mux.js (we tried it; it only does TS→fMP4, not fMP4→TS).
 */
import { request, Agent } from 'undici';
import muxjs from 'mux.js';
import {
  walkBoxes, findBox, parseStsd, parseTenc, parseStsdEntry, codecString,
  decryptMediaSegment
} from './bmff.js';
import { parseManifest, resolveTemplate } from './dash.js';
import { resolveFreshKeyAndUrl } from './playlist.js';
import { TSMuxer, buildAnnexBFromAvcc, sampleToAnnexB, aacToADTS } from './tsmux.js';
import { parseMoof, parseInitTrack } from './mp4demux.js';
import { parseASC, findASCFromEsds } from './aac.js';

const agent = new Agent({ connections: 32, keepAliveTimeout: 30_000 });
const FETCH_TIMEOUT = 20_000;

async function fetchBuf (url, headers = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const r = await request(url, { dispatcher: agent, signal: ctrl.signal, headers, maxRedirections: 5 });
    if (r.statusCode >= 400) throw new Error(`HTTP ${r.statusCode} for ${url.slice(0,150)}`);
    return Buffer.from(await r.body.arrayBuffer());
  } finally { clearTimeout(to); }
}

function parseInitSeg (buf) {
  const moov = findBox(buf, 'moov')[0];
  if (!moov) throw new Error('no moov in init');
  const traks = findBox(buf, 'trak', moov.offset, moov.end);
  const result = {};
  for (const trak of traks) {
    const hdlr = findBox(buf, 'hdlr', trak.offset, trak.end)[0];
    if (!hdlr) continue;
    const hdlrType = String.fromCharCode(buf[hdlr.offset+8], buf[hdlr.offset+9], buf[hdlr.offset+10], buf[hdlr.offset+11]);
    const mdia = findBox(buf, 'mdia', trak.offset, trak.end)[0];
    const mdhd = findBox(buf, 'mdhd', mdia.offset, mdia.end)[0];
    const mdhdVer = buf[mdhd.offset];
    let dp = mdhd.offset + 4;
    if (mdhdVer === 1) dp += 16; else dp += 8;
    const timescale = buf.readUInt32BE(dp);
    const stbl = findBox(buf, 'stbl', trak.offset, trak.end)[0];
    if (!stbl) continue;
    const stsd = findBox(buf, 'stsd', stbl.offset, stbl.end)[0];
    const entries = stsd ? parseStsd(buf, stsd) : [];
    const entry = entries[0];
    const tenc = findBox(buf, 'tenc', stbl.offset, stbl.end)[0];
    const tencInfo = tenc ? parseTenc(buf, tenc) : null;
    const kind = hdlrType === 'vide' ? 'video' : hdlrType === 'soun' ? 'audio' : hdlrType;
    result[kind] = { hdlrType, entries, entry, tencInfo, timescale, initBuf: buf };
    if (kind === 'video') {
      result[kind].avcC = entry.avcC;
      result[kind].width = entry.width;
      result[kind].height = entry.height;
      // length size from avcC[4] low 2 bits
      result[kind].lengthSize = entry.avcC ? (entry.avcC[4] & 3) + 1 : 4;
      result[kind].spspps = entry.avcC ? buildAnnexBFromAvcc(entry.avcC) : null;
    } else if (kind === 'audio') {
      // find ESDS / AudioSpecificConfig
      let asc = entry.esds ? findASCFromEsds(buf, entry) : null;
      // sometimes esds is sibling of sinf not inside (we parsed it in parseStsdEntry; find manually)
      if (!asc) {
        const esdsBox = findBox(buf, 'esds', stbl.offset, stbl.end)[0];
        if (esdsBox) {
          asc = findASCFromEsds(buf, { esds: Buffer.from(buf.slice(esdsBox.offset, esdsBox.end)) });
        }
      }
      result[kind].asc = asc;
      if (asc) {
        const a = parseASC(asc);
        result[kind].aacInfo = a;
      } else {
        result[kind].aacInfo = { aot: 2, sampleRate: entry.sampleRate || 48000, channels: 2 };
      }
    }
  }
  return result;
}

class ChannelPipeline {
  constructor (ch, log) {
    this.ch = ch;
    this.log = log;
    this.clients = new Set();
    this.running = false;
    this.muxer = null;
    this.sentSegTimes = new Set();
    this.videoTrack = null;
    this.audioTrack = null;
    this._mpdBase = '';
    this._lastVTime = 0;
    this._lastATime = 0;
    this._avAlignDone = false;
  }

  addClient (res) {
    // Give the new client a one-shot PAT+PMT burst so VLC/Kodi can latch on even
    // if they join mid-segment (critical for Render/CDN edge reconnects). The
    // burst carries fresh CC values so it slots in without breaking existing
    // viewers' CC continuity.
    if (this.muxer) {
      const psi = this.muxer.makePSIBurst();
      if (psi.length) {
        try { res.raw.write(psi); } catch { /* client gone */ }
      }
    }
    this.clients.add(res);
    if (!this.running) this.start();
  }
  removeClient (res) {
    this.clients.delete(res);
    if (this.clients.size === 0 && this.running) this.running = false;
  }

  writeToAll (buf) {
    for (const c of this.clients) {
      try { c.raw.write(buf); } catch { /* client gone */ }
    }
  }

  async start () {
    if (this.running) return;
    this.running = true;
    try { await this.runLoop(); }
    catch (e) {
      this.log('error', `pipeline crash: ${e.message}\n${e.stack}`);
      for (const c of this.clients) { try { c.raw.end(); } catch {} }
      this.clients.clear();
      this.running = false;
    }
  }

  _proxify (cdnUrl) {
    // If URL is already proxied, return as-is
    if (cdnUrl.includes('fan.kaizokutv.me')) return cdnUrl;
    const token = this._hdneaToken;
    if (!token) return cdnUrl;
    const cookie = '__hdnea__=' + token;
    const sep = cdnUrl.includes('?') ? '&' : '?';
    // Use %7C for the pipe (URL-safe) — kaizoku fan proxy expects __hdnea__=... in query and xxx=%7Ccookie=__hdnea__=...
    const inner = `${cdnUrl}${sep}__hdnea__=${token}&xxx=%7Ccookie=${cookie}`;
    return 'https://fan.kaizokutv.me/prox/jio-prox.php?url=' + encodeURIComponent(inner);
  }

  async runLoop () {
    const resolved = await resolveFreshKeyAndUrl(this.ch);
    if (!resolved) throw new Error('no key for channel');
    this.key = resolved.key;
    this.ch.url = resolved.url;
    this.log('info', `key resolved kid=${resolved.kidHex} url=${resolved.url.slice(0,120)}...`);

    // Extract cookie token from channel headers (if playlist had fresh hdnea cookie)
    let freshToken = '';
    const chCookie = this.ch.headers?.Cookie || '';
    const tokMatch = chCookie.match(/__hdnea__=([^;]+)/);
    if (tokMatch) freshToken = tokMatch[1];

    // Decide which MPD URL to use:
    // Case A: kaizoku returned an already-proxied fan URL (player.php flow) — but it's missing token (403s).
    //         Re-wrap inner CDN URL with fresh token from playlist cookie via our _proxify().
    // Case B: playlist already provides a working proxied URL — use directly.
    let mpdUrl = resolved.url;
    const proxM = mpdUrl.match(/[?&]url=([^&]+)/);
    let innerCdnBase;
    if (proxM) {
      // Decode inner URL once
      innerCdnBase = decodeURIComponent(proxM[1]);
    } else {
      innerCdnBase = mpdUrl;
    }
    // Strip any existing __hdnea__/xxx params from innerCdnBase — we'll append fresh ones
    innerCdnBase = innerCdnBase.split('?')[0];

    if (freshToken) {
      // Use our _proxify which adds __hdnea__ + xxx=%7Ccookie=
      this._hdneaToken = freshToken;
      this._hdneaCookie = '__hdnea__=' + freshToken;
      this._mpdBase = innerCdnBase + '?__hdnea__=' + freshToken;
      mpdUrl = this._proxify(innerCdnBase);
    } else {
      this._hdneaToken = '';
      this._hdneaCookie = '';
      this._mpdBase = innerCdnBase;
    }
    this.log('info', `mpd url head: ${mpdUrl.slice(0,180)}`);

    const mpdHeaders = {
      'User-Agent': this.ch.headers['User-Agent'],
      'Referer': this.ch.headers.Referer || 'https://kaizokutv.me/',
      'Origin': this.ch.headers.Origin || ''
    };
    let mpdBuf = await fetchBuf(mpdUrl, mpdHeaders);

    const mpd = parseManifest(mpdBuf.toString('utf8'), this._mpdBase);
    if (!mpd.video && !mpd.audio) throw new Error('no playable tracks');

    const fetchInit = async (rep) => {
      // Rep initTmpl may be relative to MPD base (which is CDN base, potentially with token).
      // Resolve via URL resolution
      const initRel = resolveTemplate(rep.tpl.initTmpl, rep.id);
      const initAbs = new URL(initRel, this._mpdBase).href;
      const initUrl = initAbs.includes('fan.kaizokutv.me') ? initAbs : this._proxify(initAbs);
      const buf = await fetchBuf(initUrl, mpdHeaders);
      return { buf, tracks: parseInitSeg(buf), initAbs };
    };

    const [vInit, aInit] = await Promise.all([
      mpd.video ? fetchInit(mpd.video) : null,
      mpd.audio ? fetchInit(mpd.audio) : null,
    ]);
    this.videoTrack = vInit;
    this.audioTrack = aInit;
    this.muxer = new TSMuxer();
    this.muxer.setHasVideo(!!vInit);
    this.muxer.setHasAudio(!!aInit);

    // Pre-compute Annex-B SPS/PPS for video
    const vInfo = vInit?.tracks?.video;
    const aInfo = aInit?.tracks?.audio;

    // PTS clock: convert from track timescale to 90kHz (MPEG-TS clock)
    const vTimescale = vInfo?.timescale || 600;
    const aTimescale = aInfo?.timescale || 48000;
    const TS_CLOCK = 90000;

    // Write PAT/PMT immediately so clients see a valid stream
    this.writeToAll(this.muxer.consume());

    // Resolve absolute CDN segment URL then proxify
    const resolveSegUrl = (tmpl, repId, t) => {
      let r = resolveTemplate(tmpl, repId, t);
      const abs = new URL(r, this._mpdBase).href;
      return abs.includes('fan.kaizokutv.me') ? abs : this._proxify(abs);
    };

    let mpdRefreshAt = Date.now() + 4000;
    let manifest = mpd;

    // Live wall-clock PTS (90 kHz). We do NOT translate to near-zero: both tracks
    // in the Jio DASH stream share the same producer clock, so converting track-
    // timescale PTS to 90kHz gives us matching timelines for audio and video
    // automatically. We only guard against discontinuities/backwards steps
    // (shouldn't happen on a healthy live segment, but safety first).
    let lastVPts90k = -Infinity;
    let lastAPts90k = -Infinity;
    let seenVKey = false;
    let firstVPts = -1;

    // Pending sample queue so we can interleave in PTS order even when audio and
    // video segments finish fetching at slightly different times.
    const pending = []; // {kind:'v'|'a', pts, dts, isKey, data}

    const flushInOrder = () => {
      // Sort pending by PTS and mux. Audio samples that arrive before the first
      // video keyframe are dropped — they'd otherwise pre-roll with no video to
      // latch to and produce a ~100ms audio lead at channel open.
      pending.sort((x, y) => x.pts - y.pts);
      for (const nxt of pending) {
        if (nxt.kind === 'v') {
          if (nxt.isKey && firstVPts < 0) { seenVKey = true; firstVPts = nxt.pts; }
          if (nxt.pts <= lastVPts90k) nxt.pts = lastVPts90k + 3003; // ~33ms step
          if (nxt.dts <= lastVPts90k) nxt.dts = nxt.pts;
          this.muxer.writeVideo(nxt.data, nxt.pts, nxt.dts, nxt.isKey);
          lastVPts90k = nxt.pts;
        } else {
          if (!seenVKey) continue; // drop pre-roll audio until first IDR lands
          // Clamp audio so it never starts before the first video PTS — prevents
          // the ~100ms audio lead at channel open that happens when audio segment
          // samples decode ~1 segment-time before the first IDR arrives.
          if (firstVPts >= 0 && nxt.pts < firstVPts) { nxt.pts = firstVPts; }
          if (nxt.pts <= lastAPts90k) nxt.pts = lastAPts90k + 1024; // ~11ms step
          this.muxer.writeAudio(nxt.data, nxt.pts);
          lastAPts90k = nxt.pts;
        }
      }
      pending.length = 0;
    };

    while (this.running) {
      if (Date.now() > mpdRefreshAt) {
        try {
          const fresh = await fetchBuf(mpdUrl, mpdHeaders);
          manifest = parseManifest(fresh.toString('utf8'), this._mpdBase);
          mpdRefreshAt = Date.now() + 4000;
        } catch (e) { this.log('warn', 'mpd refresh failed: '+e.message); mpdRefreshAt = Date.now()+2000; }
      }

      const pickNext = (segs, lastSentT) => {
        for (let i = segs.length - 1; i >= 0; i--) {
          if (segs[i].t <= lastSentT) return segs[i+1] || null;
        }
        return segs[segs.length-1] || null;
      };
      const lastSentV = Math.max(0, ...[...this.sentSegTimes].filter(s=>s.startsWith('v:')).map(s=>Number(s.slice(2))));
      const lastSentA = Math.max(0, ...[...this.sentSegTimes].filter(s=>s.startsWith('a:')).map(s=>Number(s.slice(2))));
      const nextV = vInfo ? pickNext(manifest.video.tpl.timeline, lastSentV) : null;
      const nextA = aInfo ? pickNext(manifest.audio.tpl.timeline, lastSentA) : null;

      const tasks = [];

      if (nextV && vInfo) {
        const k = `v:${nextV.t}`;
        if (!this.sentSegTimes.has(k)) {
          this.sentSegTimes.add(k);
          tasks.push((async () => {
            const url = resolveSegUrl(manifest.video.tpl.mediaTmpl, manifest.video.id, nextV.t);
            this.log('debug', `v seg t=${nextV.t} url=${url.slice(url.length-120)}`);
            let buf = await fetchBuf(url, mpdHeaders);
            const dec = decryptMediaSegment(buf, vInfo.tencInfo || {ivSize:8}, this.key);
            const samples = parseMoof(dec, vInfo);
            const out = [];
            for (const s of samples) {
              // Convert track-timescale pts/dts to 90 kHz using BigInt to keep
              // precision on large wall-clock timestamps (47000+s @ 90kHz ≈ 2^32).
              const pts90k = Math.round(Number(BigInt(s.pts) * 90000n / BigInt(vTimescale)));
              const dts90k = Math.round(Number(BigInt(s.dts) * 90000n / BigInt(vTimescale)));
              const au = sampleToAnnexB(s.data, vInfo.lengthSize||4, s.isKey ? vInfo.spspps : null);
              out.push({kind:'v', pts: pts90k, dts: dts90k, isKey: s.isKey, data: au});
            }
            pending.push(...out);
          })().catch(e => this.log('warn','v seg fail: '+e.message)));
        }
      }
      if (nextA && aInfo) {
        const k = `a:${nextA.t}`;
        if (!this.sentSegTimes.has(k)) {
          this.sentSegTimes.add(k);
          tasks.push((async () => {
            const url = resolveSegUrl(manifest.audio.tpl.mediaTmpl, manifest.audio.id, nextA.t);
            this.log('debug', `a seg t=${nextA.t} url=${url.slice(-100)}`);
            let buf = await fetchBuf(url, mpdHeaders);
            const dec = decryptMediaSegment(buf, aInfo.tencInfo || {ivSize:8}, this.key);
            const samples = parseMoof(dec, aInfo);
            const aaci = aInfo.aacInfo;
            const out = [];
            for (const s of samples) {
              const pts90k = Math.round(Number(BigInt(s.pts) * 90000n / BigInt(aTimescale)));
              const withAdts = aacToADTS(s.data, aaci.sampleRate, aaci.channels, aaci.aot);
              out.push({kind:'a', pts: pts90k, dts: pts90k, isKey: false, data: withAdts});
            }
            pending.push(...out);
          })().catch(e => this.log('warn','a seg fail: '+e.message)));
        }
      }

      await Promise.all(tasks);

      // Flush queued samples to muxer in PTS order
      flushInOrder();

      // Flush muxer to clients
      const out = this.muxer.consume();
      if (out.length > 0) this.writeToAll(out);

      if (this.sentSegTimes.size > 200) {
        const arr = [...this.sentSegTimes];
        this.sentSegTimes = new Set(arr.slice(-80));
      }

      if (this.clients.size === 0) { this.running = false; break; }
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

const pipelines = new Map();
export function getPipeline (ch, logger) {
  let p = pipelines.get(ch.idx);
  if (!p) { p = new ChannelPipeline(ch, (lv, msg) => logger[lv](msg)); pipelines.set(ch.idx, p); }
  return p;
}
export function cleanupPipeline (idx) {
  const p = pipelines.get(idx);
  if (p && p.clients.size === 0) pipelines.delete(idx);
}
