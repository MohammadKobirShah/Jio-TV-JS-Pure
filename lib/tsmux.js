/**
 * JStar Pro v4.2.2 — MPEG-2 TS muxer (VLC/Kodi/MX/TiviMate deep-verified)
 *
 * Key correctness fixes (this release):
 *   - PES flags1 byte: 0b10 marker in bits 7-6 is MANDATORY. Earlier code set
 *     0x40 (bit 6) for alignment, which broke the marker (produced 0b11...).
 *     Correct layout (MSB→LSB): marker(2)=10, scrambling(2)=00, priority(1)=0,
 *     data_alignment_indicator(1)=1, copyright(1)=0, original(1)=0 → 0x84.
 *   - data_alignment_indicator=1 on BOTH audio and video PES (we always start
 *     with a video start code / ADTS syncword).
 *   - Audio PES sets real PES_packet_length; video PES keeps 0 (unbounded live).
 *   - Last TS packet of EVERY PES uses AF stuffing instead of leaking 0xFF
 *     into the ES. Leaking 0xFF caused false ADTS syncs (0xFF Fx) that
 *     confused decoders into ghost frames / ch=7 / bad-len.
 *   - pcrOnlyPacket uses aflen=183; PCR base/ext layout, PTS/DTS 30-bit shift,
 *     CRC32/MPEG2 non-reflected (0x04C11DB7).
 *   - Per-muxer CC state (no cross-stream collisions).
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

// Build a descriptor loop (tag + length + bytes). Returns Buffer.
function buildDescriptors (entries) {
  const bufs = [];
  for (const d of entries) bufs.push(d);
  return Buffer.concat(bufs);
}
function descRegistration (fourCCstr) {
  // ISO 13818-1 registration descriptor: tag=0x05 len=4, format_identifier(4)
  const b = Buffer.alloc(6);
  b[0] = 0x05; b[1] = 4;
  b.write(fourCCstr, 2, 4, 'ascii');
  return b;
}
function descAVCVideo (profileIdc, constraintFlags, levelIdc /* 1 byte like 31=3.1 */) {
  // ISO 13818-1 / ITU-T H.264 AVC video descriptor: tag=0x28
  // layout(4 bytes): profile_idc(1), constraint_set0-5+2reserved(1), level_idc(1),
  //   compat_flags(1) [all zero = AVC still present, no 24h, no still, no CID]
  const b = Buffer.alloc(6);
  b[0] = 0x28; b[1] = 4;
  b[2] = profileIdc & 0xFF;
  b[3] = constraintFlags & 0xFF;
  b[4] = levelIdc & 0xFF;
  b[5] = 0xFF;                                 // AVC_still_present=1, AVC_24h_picture=1 (safest/max-compat)
  return b;
}
function descISO639Lang (lang3) {
  // ISO 639 language descriptor (tag=0x0A, len=4): 'ben' 'und' etc + audio_type=0 (clean)
  const b = Buffer.alloc(6);
  b[0] = 0x0A; b[1] = 4;
  b.write(lang3 || 'und', 2, 3, 'ascii');
  b[5] = 0;
  return b;
}

function buildPMT (hasV, hasA, vInfo) {
  // Build per-stream descriptors
  let vDesc = Buffer.alloc(0), aDesc = Buffer.alloc(0);
  if (hasV) {
    const profile = (vInfo && vInfo.profileIdc) || 100;   // High profile default
    const constr  = (vInfo && vInfo.constraintSet) || 0;
    const level   = (vInfo && vInfo.levelIdc) || 31;      // 3.1 default
    vDesc = buildDescriptors([descRegistration('AVC1'), descAVCVideo(profile, constr, level)]);
  }
  if (hasA) {
    aDesc = buildDescriptors([descRegistration('AAAC'), descISO639Lang('ben')]);
  }

  const pieces = [];
  pieces.push(Buffer.from([0x02]));              // table_id = PMT
  const nStreams = (hasV ? 1 : 0) + (hasA ? 1 : 0);
  // Each stream entry: stream_type(1) + pid(2:0xE000|pid) + es_info_len(2) + descriptors(vLen/aLen)
  const vESLen = 5 + vDesc.length;
  const aESLen = 5 + aDesc.length;
  // section_length: tsid(2)+vc(1)+sec/lsec(2)+pcr_pid(2)+pil(2)+streamEntries + crc(4)
  const sl = 13 + (hasV ? vESLen : 0) + (hasA ? aESLen : 0);
  const sh = Buffer.alloc(11);
  w16(sh, 0, 0xB000 | sl);
  w16(sh, 2, 1);                                 // program_number = 1
  sh[4] = 0xC1; sh[5] = 0; sh[6] = 0;            // version 0 current=1 sec 0/0
  w16(sh, 7, 0xE000 | PID_V);                    // PCR_PID = video
  w16(sh, 9, 0xF000);                            // program_info_length = 0 (no program-level desc)
  pieces.push(sh);
  if (hasV) {
    const e = Buffer.alloc(vESLen);
    e[0] = ST_H264;
    w16(e,1,0xE000|PID_V);
    w16(e,3,0xF000 | vDesc.length);              // ES_info_length (top 4 bits = 1111 reserved)
    vDesc.copy(e, 5);
    pieces.push(e);
  }
  if (hasA) {
    const e = Buffer.alloc(aESLen);
    e[0] = ST_AAC;
    w16(e,1,0xE000|PID_A);
    w16(e,3,0xF000 | aDesc.length);
    aDesc.copy(e, 5);
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
  const phLen = 9 + hdrLen;                    // 3 start + 1 sid + 2 len + 2 flags + 1 hdr_len + hdr
  const ph = Buffer.alloc(phLen);
  let p = 0;
  ph[p++] = 0; ph[p++] = 0; ph[p++] = 1;
  ph[p++] = isVideo ? 0xE0 : 0xC0;
  // PES_packet_length: for video we use 0 (unbounded); for audio we set exact length (hdrLen bytes of header after first 6 + data).
  const payloadAfterLenField = 3 + hdrLen + data.length; // flags1+flags2+hdrLen+hdr+data
  if (isVideo) {
    w16(ph, p, 0); p += 2;
  } else {
    w16(ph, p, payloadAfterLenField); p += 2;
  }
  // PES flags byte 1 (ISO 13818-1, MSB first):
  //   bits 7..6 = '10' marker
  //   bits 5..4 = scrambling_control = '00'
  //   bit  3    = PES_priority = 0
  //   bit  2    = data_alignment_indicator (1 when PES payload starts with video start code / audio syncword)
  //   bit  1    = copyright = 0
  //   bit  0    = original_or_copy = 0
  ph[p++] = 0x80 | (isKey ? 0x04 : 0x04);       // marker '10' + alignment always set (our PES always starts at AU)
  // PES flags byte 2: PTS_DTS_flags upper 2 bits (others zero)
  ph[p++] = hasDts ? 0xC0 : 0x80;
  ph[p++] = hdrLen;
  if (hasDts) { wTs(ph,p,pts,0x3); p += 5; wTs(ph,p,dts,0x1); p += 5; }
  else { wTs(ph,p,pts,0x2); p += 5; }
  return Buffer.concat([ph, data]);
}

// ---------- Packetizing ----------
function packetize (pid, isVideo, isKey, pes, ccBox, pcrPts) {
  const out = [];
  let off = 0;
  let first = true;

  // Pre-decide how many TS packets we need so the LAST packet can have AF stuffing
  // instead of leaking 0xFF into the elementary stream.
  function availableWith (afExtra) { return TS - 4 - afExtra; }
  // First packet may have 8-byte AF (afLen byte + 1 flags + 6 PCR)
  const firstAfExtra = (first && isVideo && isKey) ? 8 : 0;
  let remain = pes.length;
  let firstAvail = availableWith(firstAfExtra);

  while (remain > 0) {
    const pkt = Buffer.alloc(TS, 0xFF);
    pkt[0] = SYNC;
    let hdrLen = 4;
    let afFlags = 0;
    let afExtra = 0;

    if (first && isVideo && isKey) {
      afFlags |= 0x40 | 0x10;                    // random_access + PCR
      afExtra = 1 + 6;                           // aflen(1) + flags(1) + PCR(6) = 8 bytes; 1 byte is aflen itself counted in afExtra? careful below.
      pkt[1] = 0x40 | ((pid >> 8) & 0x1F);
      pkt[2] = pid & 0xFF;
    } else {
      pkt[1] = (first ? 0x40 : 0x00) | ((pid >> 8) & 0x1F);
      pkt[2] = pid & 0xFF;
    }

    // Determine payload bytes in this packet
    let maxPay = TS - 4 - (afExtra ? 1 + afExtra : 0); // 1 byte for adaptation_field_length
    // If remaining data does not fill maxPay AND this is the LAST packet, we need
    // to add AF stuffing bytes instead of leaking 0xFF as payload.
    const isLast = remain <= maxPay;
    let payBytes = Math.min(maxPay, remain);
    let stuffingBytes = 0;
    if (isLast && payBytes < maxPay) {
      stuffingBytes = maxPay - payBytes;         // stuffing goes into AF
    }
    // Build AF header
    let afTotal = afExtra;
    if (stuffingBytes > 0 || afExtra > 0) {
      // Need AF. If we had no prior afExtra, we need 1 byte for flags (0x00) + stuffing.
      if (afExtra === 0) { afFlags = 0; afTotal = 1 + stuffingBytes; } // flags + stuffing
      else { afTotal = 1 + afExtra + stuffingBytes; } // flags already counted in afExtra? wait recompute
      // Recompute cleanly: AF after hdr is:
      //   byte 0: adaptation_field_length (= bytes following it = flags + PCR + stuffing)
      //   byte 1: flags
      //   optional PCR if flags.PCR (6 bytes)
      //   stuffing_bytes (0xFF)
      let flags = afFlags;
      let pcrBytes = (flags & 0x10) ? 6 : 0;
      let stuffNeed = Math.max(0, (TS - 4 - 1 - payBytes) - 1 - pcrBytes); // after aflen(1) + flags(1) + pcr, rest must be stuffing
      const afLen = 1 + pcrBytes + stuffNeed;
      pkt[4] = afLen;
      pkt[5] = flags;
      if (flags & 0x10) putPcr(pkt, 6, pcrPts || 0);
      // bytes [5+1+pcrBytes .. 4+afLen] are 0xFF stuffing (pre-filled).
      hdrLen = 4 + 1 + afLen;
      pkt[3] = (payBytes > 0 ? 0x30 : 0x20) | (ccBox[pid] & 0xF);
    } else {
      pkt[3] = 0x10 | (ccBox[pid] & 0xF);        // payload only
    }
    ccBox[pid] = (ccBox[pid] + 1) & 0xF;

    if (payBytes > 0) {
      pes.copy(pkt, hdrLen, off, off + payBytes);
      off += payBytes;
      remain -= payBytes;
    }
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
    this.vInfo = null; // {profileIdc, constraintSet, levelIdc} from avcC
    this.psi = false;
    this._lastPsi = -1;
    this.lastPcr = -1;
    this.cc = { [PID_PAT]: 0, [PID_PMT]: 0, [PID_V]: 0, [PID_A]: 0 };
  }
  setHasVideo (x) { this.v = !!x; }
  setHasAudio (x) { this.a = !!x; }
  setVideoInfo (info) { this.vInfo = info; }
  _pat () { return buildPAT(); }
  _pmt () { return buildPMT(this.v, this.a, this.vInfo); }
  /** Return a one-shot PAT+PMT burst for a new client (CCs advance normally so
   *  the stream stays continuous for existing clients). */
  makePSIBurst () {
    return Buffer.concat([
      Buffer.concat(psiPackets(PID_PAT, this._pat(), this.cc)),
      Buffer.concat(psiPackets(PID_PMT, this._pmt(), this.cc)),
    ]);
  }
  /** Legacy: ensure PSI has been sent at least once. */
  forcePSI () { this._psi(); }
  _psi () {
    if (this.psi) return;
    this.chunks.push(...psiPackets(PID_PAT, this._pat(), this.cc));
    this.chunks.push(...psiPackets(PID_PMT, this._pmt(), this.cc));
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
