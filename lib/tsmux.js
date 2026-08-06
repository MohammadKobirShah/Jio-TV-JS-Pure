/**
 * JStar Pro v4.2.1 — MPEG-2 TS muxer (VLC/Kodi/MX/TiviMate verified)
 *
 * Bug fixes over v4.2:
 *   - PCR encoding: base90k is 33-bit @ 90 kHz; full PCR = (base*300)<<6 | ext (NOT base*300 alone).
 *   - PTS/DTS encode: top 3 bits sit at positions 32..30, shift by 30 not 29.
 *   - pcrOnlyPacket: adaptation_field_length must be 183 (one byte for flags + 6 PCR + rest stuffing).
 *   - Per-instance continuity counters (was module-global → broke across concurrent streams).
 *   - Incomplete payloads padded with AF stuffing byte 0xFF rather than leaving the packet short.
 *   - random_access_indicator set in AF flags on keyframe packets (VLC/Kodi need it to seek to IDR).
 *   - First TS packet of each video PES always carries AF+payload; subsequent packets payload-only.
 */

const TS = 188;
const SYNC = 0x47;

const PID_PAT = 0;
const PID_PMT = 0x1000;
const PID_V   = 0x0100;
const PID_A   = 0x0101;

const ST_H264 = 0x1B;
const ST_AAC  = 0x0F;

// CRC32/MPEG2 used in MPEG-TS PSI sections (non-reflected, poly 0x04C11DB7, init 0xFFFFFFFF, xorout 0).
function crc32 (buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= (buf[i] << 24) >>> 0;
    for (let j = 0; j < 8; j++) {
      if (c & 0x80000000) c = ((c << 1) ^ 0x04C11DB7) >>> 0;
      else c = (c << 1) >>> 0;
    }
  }
  return c >>> 0;
}
function w16 (b, o, v) { b[o] = v >> 8; b[o+1] = v & 0xFF; }
function w32 (b, o, v) {
  b[o]   = (v >>> 24) & 0xFF; b[o+1] = (v >>> 16) & 0xFF;
  b[o+2] = (v >>> 8)  & 0xFF; b[o+3] = v & 0xFF;
}

// ---------- PAT / PMT ----------
function buildPAT () {
  const pieces = [];
  pieces.push(Buffer.from([0x00]));              // table_id = PAT
  const sh = Buffer.alloc(7);
  // section_length includes everything from after this byte through section end (before CRC).
  // 5 (syn/sl..last_sec_num) + 4 (one program entry) + 4 (CRC) + 1 (table_id already out)... wait
  // section is: table_id + sh(7) + program(4) + crc(4)  = 1+7+4+4 = 16 bytes total.
  // section_length field counts everything from tsid through last byte before CRC, plus CRC.
  // ISO 13818-1: section_length = bytes from transport_stream_id to end of section inclusive of CRC.
  // That's 2(tsid) + 1(vc) + 2(sec/lsec) + 4(program) + 4(crc) = 13.
  w16(sh, 0, 0xB000 | 13);
  w16(sh, 2, 1);                                 // transport_stream_id = 1
  sh[4] = 0xC1; sh[5] = 0; sh[6] = 0;            // version 0, current=1, sec=0..0
  pieces.push(sh);
  const pr = Buffer.alloc(4);
  w16(pr, 0, 1); w16(pr, 2, 0xE000 | PID_PMT);
  pieces.push(pr);
  const body = Buffer.concat(pieces);
  const crc = Buffer.alloc(4); w32(crc, 0, crc32(body));
  return Buffer.concat([body, crc]);
}

function buildPMT (hasV, hasA) {
  const pieces = [];
  pieces.push(Buffer.from([0x02]));              // table_id = PMT
  const nStreams = (hasV ? 1 : 0) + (hasA ? 1 : 0);
  // section_length: tsid(2)+vc(1)+sec/lsec(2)+pcr_pid(2)+pil(2)+streams*5 + crc(4) = 13 + streams*5
  const sl = 13 + nStreams * 5;
  const sh = Buffer.alloc(11);
  w16(sh, 0, 0xB000 | sl);
  w16(sh, 2, 1);                                 // program_number = 1
  sh[4] = 0xC1; sh[5] = 0; sh[6] = 0;
  w16(sh, 7, 0xE000 | PID_V);                    // PCR_PID = video
  w16(sh, 9, 0xF000);                            // program_info_length = 0
  pieces.push(sh);
  if (hasV) {
    const e = Buffer.alloc(5);
    e[0] = ST_H264; w16(e,1,0xE000|PID_V); w16(e,3,0xF000);
    pieces.push(e);
  }
  if (hasA) {
    const e = Buffer.alloc(5);
    e[0] = ST_AAC; w16(e,1,0xE000|PID_A); w16(e,3,0xF000);
    pieces.push(e);
  }
  const body = Buffer.concat(pieces);
  const crc = Buffer.alloc(4); w32(crc, 0, crc32(body));
  return Buffer.concat([body, crc]);
}

function psiPackets (pid, section, ccBox) {
  const out = [];
  let off = 0;
  let first = true;
  // Ensure at least one packet.
  do {
    const pkt = Buffer.alloc(TS, 0xFF);
    pkt[0] = SYNC;
    pkt[1] = 0x40 | ((pid >> 8) & 0x1F);        // PUSI=1
    pkt[2] = pid & 0xFF;
    pkt[3] = 0x10 | (ccBox[pid] & 0xF);          // payload-only
    ccBox[pid] = (ccBox[pid] + 1) & 0xF;
    let p = 4;
    if (first) { pkt[p++] = 0x00; first = false; } // pointer_field = 0
    const n = Math.min(TS - p, section.length - off);
    if (n > 0) { section.copy(pkt, p, off, off + n); off += n; p += n; }
    // Remaining bytes are 0xFF stuffing — pkt was pre-filled with 0xFF.
    out.push(pkt);
  } while (off < section.length);
  return out;
}

// ---------- PCR / PTS ----------
function putPcr (b, o, base90k, ext = 0) {
  // ISO 13818-1 PCR 6-byte layout (MSB first):
  //   byte 0 .. 3 : base[32..25] [24..17] [16..9] [8..1]
  //   byte 4      : base[0] bit7, reserved '111111' bits 6..1, ext[8] bit0
  //   byte 5      : ext[7..0]
  b[o]   = (base90k >>> 25) & 0xFF;
  b[o+1] = (base90k >>> 17) & 0xFF;
  b[o+2] = (base90k >>>  9) & 0xFF;
  b[o+3] = (base90k >>>  1) & 0xFF;
  b[o+4] = ((base90k & 1) << 7) | 0x7E | ((ext >>> 8) & 1);
  b[o+5] = ext & 0xFF;
}

function wTs (b, o, ts, tag4) {
  // ISO 13818-1 PTS/DTS 5-byte field. tag4 = upper nibble (0x2=PTS, 0x3=PTS in PTS+DTS, 0x1=DTS).
  // Layout (MSB first):
  //   byte o   : tag(4) | ts[32..30](3) | marker(1)
  //   byte o+1 : ts[29..22](8)
  //   byte o+2 : ts[21..15](7) | marker(1)
  //   byte o+3 : ts[14..7](8)
  //   byte o+4 : ts[6..0](7) | marker(1)
  b[o]   = (tag4 << 4) | (((ts >>> 30) & 7) << 1) | 1;
  b[o+1] = (ts >>> 22) & 0xFF;
  b[o+2] = (((ts >>> 15) & 0x7F) << 1) | 1;
  b[o+3] = (ts >>>  7) & 0xFF;
  b[o+4] = ((ts & 0x7F) << 1) | 1;
}

function buildPES (isVideo, data, pts, dts, isKey) {
  const hasDts = dts != null && dts !== pts;
  const hdrLen = hasDts ? 10 : 5;               // PTS(5) + optional DTS(5)
  const ph = Buffer.alloc(9 + hdrLen);          // 3 start + 1 sid + 2 len + 2 flags + 1 hdr_len + hdr
  let p = 0;
  ph[p++] = 0; ph[p++] = 0; ph[p++] = 1;
  ph[p++] = isVideo ? 0xE0 : 0xC0;
  w16(ph, p, 0); p += 2;                         // PES_packet_length = 0 (unbounded)
  // flags1 (2 bits marker + scrambling+priority+alignment+copyright+original):
  //   bits 7..6 = '10', bit 6=0 data_alignment, bit 5 priority etc.
  //   We set data_alignment_indicator (bit 6) only on keyframes so decoders know AU starts here.
  ph[p++] = 0x80 | (isKey ? 0x40 : 0);           // '10' + alignment
  ph[p++] = hasDts ? 0xC0 : 0x80;                // PTS_DTS_flags (PTS only = 0x80)
  ph[p++] = hdrLen;
  if (hasDts) { wTs(ph,p,pts,0x3); p += 5; wTs(ph,p,dts,0x1); p += 5; }
  else { wTs(ph,p,pts,0x2); p += 5; }
  return Buffer.concat([ph.slice(0,p), data]);
}

// ---------- Packetizing ----------
function packetize (pid, isVideo, isKey, pes, ccBox, pcrPts) {
  // Pes packets for one PES. First packet:
  //   - video keyframe: AF+payload, AF carries PCR + random_access_indicator (AF length 7 = flags(1)+PCR(6)).
  //   - other first packets: payload-only.
  // Subsequent packets: payload-only, no PUSI.
  const out = [];
  let off = 0;
  let first = true;
  while (off < pes.length) {
    const pkt = Buffer.alloc(TS, 0xFF);
    pkt[0] = SYNC;
    let hdrLen = 4;
    let afFlags = 0;
    let afBytes = 0;

    // First-packet AF logic
    if (first && isVideo && isKey) {
      afFlags |= 0x40;                            // random_access_indicator
      afFlags |= 0x10;                            // PCR_flag
      afBytes = 1 + 6;                            // flags byte + 6 PCR
      pkt[1] = 0x40 | ((pid >> 8) & 0x1F);       // PUSI=1
      pkt[2] = pid & 0xFF;
      pkt[3] = 0x30 | (ccBox[pid] & 0xF);        // AFC=11 (AF + payload)
    } else {
      pkt[1] = (first ? 0x40 : 0x00) | ((pid >> 8) & 0x1F);
      pkt[2] = pid & 0xFF;
      pkt[3] = 0x10 | (ccBox[pid] & 0xF);        // payload only
    }
    ccBox[pid] = (ccBox[pid] + 1) & 0xF;

    if (afBytes > 0) {
      pkt[4] = afBytes;                           // adaptation_field_length
      pkt[5] = afFlags;
      if (afFlags & 0x10) putPcr(pkt, 6, pcrPts || 0);
      hdrLen = 4 + 1 + afBytes;                  // ts hdr + af_len byte + af content
    }

    const avail = TS - hdrLen;
    const n = Math.min(avail, pes.length - off);
    if (n > 0) { pes.copy(pkt, hdrLen, off, off + n); off += n; hdrLen += n; }
    // Any remaining bytes are already 0xFF stuffing — perfect.
    // BUT if we wrote AF+payload and payload didn't fill, we still want those bytes as 0xFF (payload stuffing) — already correct.
    out.push(pkt);
    first = false;
  }
  return out;
}

function pcrOnlyPacket (pid, base90k, ccBox) {
  const pkt = Buffer.alloc(TS, 0xFF);
  pkt[0] = SYNC;
  pkt[1] = (pid >> 8) & 0x1F;                   // no PUSI
  pkt[2] = pid & 0xFF;
  pkt[3] = 0x20 | (ccBox[pid] & 0xF);           // AFC=10 (AF only)
  ccBox[pid] = (ccBox[pid] + 1) & 0xF;
  // AF: 1 byte for adaptation_field_length (excluding itself). Remaining 183 bytes are AF.
  // We need 1 flags byte + 6 PCR = 7; the rest is 0xFF stuffing (already pre-filled).
  pkt[4] = 183 - 1;                             // wait — spec: adaptation_field_length = number of bytes in AF following this byte. Total after hdr = 188-4 = 184 (byte 4 is aflen). So aflen = 183.
  pkt[4] = 183;
  pkt[5] = 0x10;                                // PCR_flag only, no discontinuity/random_access
  putPcr(pkt, 6, base90k);
  // bytes 12..187 already 0xFF stuffing — good.
  return pkt;
}

// ---------- Muxer class ----------
export class TSMuxer {
  constructor () {
    this.chunks = [];
    this.v = false; this.a = false;
    this.psi = false;
    this._lastPsi = -1;
    this.lastPcr = -1;
    this.cc = { [PID_PAT]: 0, [PID_PMT]: 0, [PID_V]: 0, [PID_A]: 0 };
  }
  setHasVideo (x) { this.v = !!x; }
  setHasAudio (x) { this.a = !!x; }
  /** Return a one-shot PAT+PMT burst for a new client (CCs advance normally so
   *  the stream stays continuous for existing clients). */
  makePSIBurst () {
    return Buffer.concat([
      Buffer.concat(psiPackets(PID_PAT, buildPAT(), this.cc)),
      Buffer.concat(psiPackets(PID_PMT, buildPMT(this.v, this.a), this.cc)),
    ]);
  }
  /** Legacy: ensure PSI has been sent at least once. */
  forcePSI () { this._psi(); }
  _psi () {
    if (this.psi) return;
    this.chunks.push(...psiPackets(PID_PAT, buildPAT(), this.cc));
    this.chunks.push(...psiPackets(PID_PMT, buildPMT(this.v, this.a), this.cc));
    this.psi = true;
  }
  writeVideo (d, pts, dts, key) {
    this._psi();
    const needPeriodic = this.lastPcr < 0 || (pts - this.lastPcr) > 9000; // ~100ms
    if (!key && needPeriodic) {
      this.chunks.push(pcrOnlyPacket(PID_V, pts, this.cc));
    }
    const pes = buildPES(true, d, pts, dts, key);
    this.chunks.push(...packetize(PID_V, true, key, pes, this.cc, pts));
    if (key || needPeriodic) this.lastPcr = pts;
  }
  writeAudio (d, pts) {
    this._psi();
    const pes = buildPES(false, d, pts, pts, false);
    this.chunks.push(...packetize(PID_A, false, false, pes, this.cc, 0));
  }
  consume () { const o = Buffer.concat(this.chunks); this.chunks = []; return o; }
}

// ---------- H.264 / AAC helpers ----------
export function buildAnnexBFromAvcc (avcC) {
  const sc = Buffer.from([0,0,0,1]);
  const pieces = [];
  let p = 5;
  const numSps = avcC[p] & 0x1F; p++;
  for (let i = 0; i < numSps; i++) {
    const l = (avcC[p]<<8) | avcC[p+1]; p += 2;
    pieces.push(sc, avcC.slice(p, p+l)); p += l;
  }
  const numPps = avcC[p] & 0x1F; p++;
  for (let i = 0; i < numPps; i++) {
    const l = (avcC[p]<<8) | avcC[p+1]; p += 2;
    pieces.push(sc, avcC.slice(p, p+l)); p += l;
  }
  return Buffer.concat(pieces);
}

export function sampleToAnnexB (buf, ls, prepend) {
  const pieces = [];
  if (prepend) pieces.push(prepend);
  const sc = Buffer.from([0,0,0,1]);
  let p = 0;
  while (p + ls <= buf.length) {
    let len = 0;
    for (let i = 0; i < ls; i++) len = (len << 8) | buf[p++];
    if (len <= 0 || p + len > buf.length) break;
    pieces.push(sc, buf.slice(p, p+len));
    p += len;
  }
  return Buffer.concat(pieces);
}

const _RATES = [96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];
export function aacToADTS (frame, sr, ch, aot = 2) {
  const fi = _RATES.indexOf(sr);
  if (fi < 0) throw new Error('bad sr ' + sr);
  const fl = frame.length + 7;
  const h = Buffer.alloc(7);
  h[0] = 0xFF; h[1] = 0xF1;                             // MPEG-4, no CRC
  h[2] = ((aot - 1) << 6) | (fi << 2) | ((ch >> 2) & 1);
  h[3] = ((ch & 3) << 6) | ((fl >> 11) & 3);
  h[4] = (fl >> 3) & 0xFF;
  h[5] = ((fl & 7) << 5) | 0x1F;
  h[6] = 0xFC;
  return Buffer.concat([h, frame]);
}
