/**
 * Minimal ISOBMFF (fMP4 / CENC) box parser — Kobir Shah Edition ☕
 *
 * Supports just enough to:
 *   - Walk boxes by 4CC
 *   - Read init segment: ftyp, moov (mvhd/trak/mdia/minf/stbl/stsd/stts/stsc/stsz/stco/co64/stss/ctts/edts)
 *   - Extract PSSH/KID from tenc/saio/saiz/senc/sidx
 *   - Walk media segment moof+mdat and apply AES-CTR CENC decryption in-place
 *
 * Reference: ISO/IEC 14496-12, 23001-7 (CENC).
 * Jio Broadpeak BkS350 uses: full-sample AES-CTR (cenc) with per-sample 8-byte constant IV
 * carried in senc (no PSSH in init), saio points to senc offsets, saiz gives sizes.
 */

import { createDecipheriv } from 'node:crypto';

const textDecoder = new TextDecoder('utf-8');

export function u32 (buf, off) {
  return buf[off] * 0x1000000 + (buf[off+1] << 16) + (buf[off+2] << 8) + buf[off+3] >>> 0;
}
export function u24 (buf, off) {
  return (buf[off] << 16) + (buf[off+1] << 8) + buf[off+2] >>> 0;
}
export function u16 (buf, off) {
  return (buf[off] << 8) | buf[off+1];
}
export function u8  (buf, off) { return buf[off]; }
export function u64HiLo (buf, off) {
  const hi = u32(buf, off);
  const lo = u32(buf, off+4);
  return { hi, lo };
}
// Returns Number for <= 2^53-1; throws on > 53-bit (won't happen for our 3-6 s segments)
export function u64 (buf, off) {
  const hi = u32(buf, off);
  const lo = u32(buf, off+4);
  if (hi > 0x1FFFFF) throw new Error('box too large (>2^53)');
  return hi * 0x100000000 + lo;
}
export function fourCC (buf, off) {
  return String.fromCharCode(buf[off], buf[off+1], buf[off+2], buf[off+3]);
}

/**
 * Iterate top-level boxes. Yields {type, offset(start of payload after header), size}.
 * For 64-bit largesize, size is a full 64-bit Number.
 */
export function * walkBoxes (buf, start = 0, end = buf.length) {
  let o = start;
  while (o + 8 <= end) {
    const size32 = u32(buf, o);
    const type = fourCC(buf, o+4);
    let size = size32;
    let headerLen = 8;
    if (size32 === 1) {
      if (o + 16 > end) break;
      size = u64(buf, o+8);
      headerLen = 16;
    } else if (size32 === 0) {
      // box extends to end
      size = end - o;
    }
    if (size < headerLen || o + size > end) break;
    yield { type, offset: o + headerLen, boxStart: o, size: size, end: o + size };
    o += size;
  }
}

export function findBox (buf, fourcc, start = 0, end = buf.length) {
  const out = [];
  for (const b of walkBoxes(buf, start, end)) {
    if (b.type === fourcc) out.push(b);
    // For container boxes, recurse into their payload. Some boxes (stsd, sample entries)
    // have non-box header bytes before children — compute the child-start offset accordingly.
    if (/^(moov|trak|mdia|minf|stbl|edts|moof|traf|mfra|sinf|schi|mvex|stsd|encv|enca|avc1|avc3|mp4a|hvc1|hev1|esds|dinf|dref|url|urn|stpp|wvtt)/.test(b.type)) {
      let childStart = b.offset;
      let childEnd = b.end;
      if (b.type === 'stsd') {
        // stsd payload: version(1)+flags(3)+entry_count(4) = 8 bytes before entries
        childStart = b.offset + 8;
      } else if (b.type === 'encv' || b.type === 'avc1' || b.type === 'avc3' || b.type === 'hvc1' || b.type === 'hev1') {
        // VisualSampleEntry header:
        // reserved(6)+data_ref_idx(2)+version(2)+revision(2)+vendor(4)+temporal_q(4)+spatial_q(4)
        // +width(2)+height(2)+horizres(4)+vertres(4)+reserved(4)+frame_count(2)
        // +compressor(32)+depth(2)+pre_defined(2) = 78 bytes after size+type
        childStart = b.boxStart + 8 + 78;
      } else if (b.type === 'enca' || b.type === 'mp4a') {
        // AudioSampleEntry header:
        // reserved(6)+data_ref_idx(2)+version(2)+revision(2)+vendor(4)+channels(2)+samplesize(2)
        // +reserved(4)+samplerate(4)+padding(2)? wait ISO: reserved(2)+reserved(2) after samplesize
        // total = 6+2 + 2+2+4 + 2+2 + 4 + 2+2 + 4 = 28 bytes after size+type
        childStart = b.boxStart + 8 + 28;
      }
      if (childStart < childEnd) {
        out.push(...findBox(buf, fourcc, childStart, childEnd));
      }
    }
  }
  return out;
}

// ----- specific box parsers -----

export function parseFtyp (buf, box) {
  return {
    majorBrand: fourCC(buf, box.offset),
    minorVersion: u32(buf, box.offset+4),
  };
}

export function parseTkhd (buf, box) {
  const o = box.offset;
  const version = buf[o];
  const flags = buf[o+1] << 16 | buf[o+2] << 8 | buf[o+3];
  let p = o + 4;
  const has64 = version === 1;
  if (has64) p += 16; else p += 8; // creation/mod
  p += 4; // track id
  p += 4; // reserved
  if (has64) p += 8; else p += 4; // duration
  p += 8; // reserved
  p += 2; // layer
  p += 2; // alt_group
  p += 2; // volume
  p += 2; // reserved
  // matrix 3x3 (9 * 4 bytes = 36)
  p += 36;
  const width  = u32(buf, p) / 0x10000;   p += 4;
  const height = u32(buf, p+4) / 0x10000; // p += 4
  return { trackId: u32(buf, o+4+(has64?16:8)), width, height };
}

export function parseMdhd (buf, box) {
  const o = box.offset;
  const version = buf[o];
  const has64 = version === 1;
  let p = o + 4;
  p += has64 ? 16 : 8; // c/m time
  const timescale = u32(buf, p); p += 4;
  const duration = has64 ? u64(buf, p) : u32(buf, p);
  p += has64 ? 8 : 4;
  const lang = ((buf[p]&0x7F)<<10) | ((buf[p+1]&0xFC)<<2) | ((buf[p+2]&0xF8)>>3);
  return { timescale, duration };
}

export function parseHdlr (buf, box) {
  const o = box.offset + 4; // skip version/flags
  p: { // pre_defined + handler_type
    const ht = fourCC(buf, o+4);
    return { handlerType: ht };
  }
}

// codec-specific boxes live inside stsd entries
export function parseStsdEntry (buf, entryOffset, entryEnd) {
  // Stsd entry layout: size(4) type(4) + reserved(6) data_ref_index(2) + (visual|audio|hint) fields + child boxes
  const encType = fourCC(buf, entryOffset+4);
  let effectiveCodec = encType;
  const o = entryOffset + 8;
  let p = o + 6; // reserved (6 bytes)
  p += 2; // data ref index

  const isEncrypted = encType === 'encv' || encType === 'enca';
  const isVideo = encType === 'avc1' || encType === 'avc3' || encType === 'hvc1' || encType === 'hev1' || encType === 'dvav' || encType === 'dva1' || encType === 'encv';
  const isAudio = encType === 'mp4a' || encType === 'ac-3' || encType === 'ec-3' || encType === 'opus' || encType === 'enca';

  const info = { codec: encType, encType };

  if (isVideo) {
    // VisualSampleEntry:
    p += 2 + 2 + 4 + 4 + 4; // version, revision, vendor, temporal q, spatial q
    info.width  = u16(buf, p); p += 2;
    info.height = u16(buf, p); p += 2;
    p += 4+4; // horiz/vert res (fixed 16.16)
    p += 4; // reserved=0
    p += 2; // frame count
    p += 32; // compressor name (32 bytes: 1 byte length + 31 chars)
    info.depth = u16(buf, p); p += 2;
    p += 2; // pre_defined = -1
  } else if (isAudio) {
    // AudioSampleEntry:
    p += 2 + 2 + 4 + 2 + 2; // version, revision, vendor, channelcount(2), samplesize(2)
    p += 4; // reserved
    p += 2 + 2; // reserved2
    info.sampleRate = u32(buf, p) >>> 16;
    p += 4;
  }

  // If encrypted, find sinf to learn original format
  let sinfStart = -1, sinfEnd = -1;
  // First pass: locate sinf and all child boxes
  const children = [];
  if (p < entryEnd) {
    for (const cb of walkBoxes(buf, p, entryEnd)) {
      children.push(cb);
      if (cb.type === 'sinf') { sinfStart = cb.offset; sinfEnd = cb.end; }
    }
  }

  if (isEncrypted && sinfStart >= 0) {
    // look for frma inside sinf
    for (const sb of walkBoxes(buf, sinfStart, sinfEnd)) {
      if (sb.type === 'frma') {
        effectiveCodec = fourCC(buf, sb.offset);
        info.originalCodec = effectiveCodec;
      }
    }
    info.codec = effectiveCodec;
  }

  // Now parse codec-specific child boxes (avcC, esds, hvcC, etc.) — these are SIBLINGS of sinf (not inside sinf!)
  for (const cb of children) {
    if (cb.type === 'avcC' && (effectiveCodec.startsWith('avc') || isEncrypted)) {
      info.avcC = Buffer.from(buf.slice(cb.offset, cb.end));
      info.profileIdc = buf[cb.offset+1];
      info.constraintSet = buf[cb.offset+2];
      info.levelIdc = buf[cb.offset+3];
    } else if (cb.type === 'hvcC') {
      info.hvcC = Buffer.from(buf.slice(cb.offset, cb.end));
    } else if (cb.type === 'esds' && (effectiveCodec === 'mp4a' || isEncrypted)) {
      info.esds = Buffer.from(buf.slice(cb.offset, cb.end));
    } else if (cb.type === 'btrt') {
      info.btrt = { bufferSize: u32(buf, cb.offset), maxBitrate: u32(buf, cb.offset+4), avgBitrate: u32(buf, cb.offset+8) };
    }
  }
  return info;
}

export function parseStsd (buf, box) {
  const o = box.offset + 4; // version + flags
  const count = u32(buf, o);
  const entries = [];
  let p = o + 4;
  for (let i = 0; i < count; i++) {
    if (p + 8 > buf.length) break;
    const size = u32(buf, p);
    const type = fourCC(buf, p+4);
    entries.push({ offset: p, size, end: p + size, ...parseStsdEntry(buf, p, p+size) });
    p += size;
  }
  return entries;
}

export function parseFullBoxHead (buf, offset) {
  return { version: buf[offset], flags: buf[offset+1]<<16 | buf[offset+2]<<8 | buf[offset+3] };
}

// Simple table parsers: stts (time-to-sample), stsc (sample-to-chunk), stsz (sample size), stco/co64 (chunk offset), ctts (composition offset)
export function parseStts (buf, box) {
  const o = box.offset + 4;
  const n = u32(buf, o);
  const entries = [];
  let p = o + 4;
  for (let i=0;i<n;i++){
    entries.push({ sampleCount: u32(buf,p), sampleDelta: u32(buf,p+4) });
    p += 8;
  }
  return entries;
}
export function parseStsc (buf, box) {
  const o = box.offset + 4;
  const n = u32(buf, o);
  const entries = [];
  let p = o+4;
  for (let i=0;i<n;i++){
    entries.push({ firstChunk: u32(buf,p), samplesPerChunk: u32(buf,p+4), sampleDescIdx: u32(buf,p+8) });
    p += 12;
  }
  return entries;
}
export function parseStsz (buf, box) {
  const o = box.offset + 4;
  const sampleSize = u32(buf, o);
  const n = u32(buf, o+4);
  if (sampleSize !== 0) return { constantSize: sampleSize, sizes: null, count: n };
  const sizes = new Uint32Array(n);
  let p = o+8;
  for (let i=0;i<n;i++){ sizes[i] = u32(buf,p); p+=4; }
  return { constantSize: 0, sizes, count: n };
}
export function parseStco (buf, box) {
  const o = box.offset + 4;
  const n = u32(buf, o);
  const offs = new Uint32Array(n);
  let p = o+4;
  for (let i=0;i<n;i++){ offs[i] = u32(buf,p); p+=4; }
  return { offsets: offs, is64: false };
}
export function parseCo64 (buf, box) {
  const o = box.offset + 4;
  const n = u32(buf, o);
  const offs = new Array(n);
  let p = o+4;
  for (let i=0;i<n;i++){ offs[i] = u64(buf,p); p+=8; }
  return { offsets: offs, is64: true };
}
export function parseCtts (buf, box) {
  const o = box.offset;
  const version = buf[o];
  const n = u32(buf, o+4);
  const entries = [];
  let p = o + 8;
  for (let i=0;i<n;i++){
    const cnt = u32(buf,p);
    const off = (version===0) ? (buf[p+4]<<24>>24) : u32(buf,p+4); // signed i32
    entries.push({ sampleCount: cnt, offset: off });
    p += 8;
  }
  return entries;
}

// CENC boxes
export function parseTenc (buf, box) {
  const o = box.offset;
  const v = buf[o];
  // version + flags -> 4 bytes
  let p = o + 4;
  // default_crypt_byte_block (1 byte, crypt in high nibble, low nibble reserved=0)
  const cryptByteBlock = buf[p] >> 4; p++;
  // default_skip_byte_block (1 byte, skip in high nibble)
  const skipByteBlock = buf[p] >> 4; p++;
  const isProtected = buf[p]; p++;
  const ivSize = buf[p]; p++;
  // For v>=1: if ivSize==0, default_constant_IV_size + IV follow.
  // For v==0 there's NO reserved byte between IV_size and KID
  const kid = Buffer.from(buf.slice(p, p + 16)); p += 16;
  return { version: v, ivSize, kid: kid.toString('hex'), isProtected: !!isProtected, cryptByteBlock, skipByteBlock };
}

export function parseSaiz (buf, box) {
  const o = box.offset;
  const flags = buf[o+1]<<16|buf[o+2]<<8|buf[o+3];
  let p = o+4;
  if (flags & 1) p += 8; // aux_info_type + aux_info_type_parameter
  const sampleInfoSize = buf[p]; p++;
  const count = u32(buf,p); p+=4;
  // If default_sample_info_size > 0, ALL samples use that size; no per-sample entries.
  if (sampleInfoSize > 0) return { defaultSize: sampleInfoSize, sizes: null, count };
  const sizes = new Uint8Array(count);
  for (let i=0;i<count;i++){ sizes[i] = buf[p]; p++; }
  return { defaultSize: 0, sizes, count };
}

export function parseSaio (buf, box) {
  const o = box.offset;
  const version = buf[o];
  const flags = buf[o+1]<<16|buf[o+2]<<8|buf[o+3];
  let p = o+4;
  if (flags & 1) p += 8;
  const count = u32(buf,p); p+=4;
  const offsets = [];
  for (let i=0;i<count;i++){
    offsets.push(version===0 ? u32(buf,p) : u64(buf,p));
    p += version===0 ? 4 : 8;
  }
  return { offsets };
}

// Parse senc (sample encryption) box content.
// senc layout: FullBoxHeader(4) + sample_count(4) + SampleEncryptionEntry[count]
// Each entry: IV (ivSize bytes) + if flags&0x02 (useSubsamples): subsample_count(2) + {clrBytes(2), encBytes(4)}[nsub]
export function parseSenc (buf, sencBox, ivSize, count) {
  const o = sencBox.offset;
  // version + flags: 4 bytes starting at o
  const flags = buf[o+1]<<16|buf[o+2]<<8|buf[o+3];
  const useSubsamples = !!(flags & 0x02);
  let p = o + 4;            // skip version/flags
  p += 4;                    // skip sample_count (we take count from trun)
  const ivs = [];
  for (let i=0;i<count;i++) {
    if (p + ivSize > buf.length) break;
    const iv = Buffer.alloc(16);
    if (ivSize === 8) {
      buf.copy(iv, 0, p, p+8);
      // lower 8 bytes of IV stay zero (block counter starts at 0 per CENC)
      p += 8;
    } else if (ivSize === 16) {
      buf.copy(iv, 0, p, p+16);
      p += 16;
    } else {
      // other sizes: zero-pad to 16
      buf.copy(iv, 0, p, p+ivSize);
      p += ivSize;
    }
    let subsamples = [];
    if (useSubsamples) {
      if (p + 2 > buf.length) break;
      const nsub = u16(buf,p); p+=2;
      for (let s=0;s<nsub;s++){
        if (p + 6 > buf.length) break;
        const clear = u16(buf,p); p+=2;
        const enc   = u32(buf,p); p+=4;
        subsamples.push({ clearBytes: clear, encryptedBytes: enc });
      }
    }
    ivs.push({ iv, subsamples });
  }
  return ivs;
}

// ----- Decryption for one media segment -----
// Returns new decrypted Uint8Array/Buffer. tencInfo comes from init segment (ivSize, default kid).
// key is 16-byte Buffer.
export function decryptMediaSegment (segBuf, tencInfo, key) {
  if (!key) throw new Error('missing key');
  const out = Buffer.from(segBuf); // mutable copy

  const topBoxes = [...walkBoxes(out)];
  for (let bi=0; bi<topBoxes.length; bi++) {
    if (topBoxes[bi].type !== 'moof') continue;
    const moof = topBoxes[bi];
    // find the next mdat after this moof
    let mdat = null;
    for (let bj=bi+1; bj<topBoxes.length; bj++) {
      if (topBoxes[bj].type === 'mdat') { mdat = topBoxes[bj]; break; }
    }
    if (!mdat) continue;

    // default IV size from tenc
    const ivSize = tencInfo?.ivSize || 8;

    const trafs = findBox(out, 'traf', moof.offset, moof.end);
    for (const traf of trafs) {
      const saiz = findBox(out, 'saiz', traf.offset, traf.end)[0];
      let   senc = findBox(out, 'senc', traf.offset, traf.end)[0];
      const trun = findBox(out, 'trun', traf.offset, traf.end)[0];
      const tfhd = findBox(out, 'tfhd', traf.offset, traf.end)[0];
      const tfdt = findBox(out, 'tfdt', traf.offset, traf.end)[0];
      if (!trun) continue;

      // --- parse trun ---
      const to = trun.offset;
      const tf = (out[to+1]<<16) | (out[to+2]<<8) | out[to+3];
      const sampleCount = u32(out, to+4);
      let p = to + 8;
      let dataOffset = 0;
      if (tf & 0x01) { dataOffset = out.readInt32BE(p); p += 4; }
      const firstSampleFlagsPresent = !!(tf & 0x04);
      if (firstSampleFlagsPresent) p += 4;
      const haveDur   = !!(tf & 0x100);
      const haveSize  = !!(tf & 0x200);
      const haveFlags = !!(tf & 0x400);
      const haveCts   = !!(tf & 0x800);

      // --- base data offset (per ISO 14496-12: defaults to moof box start) ---
      let baseOff = moof.boxStart;
      if (tfhd) {
        const tfo = tfhd.offset;
        const ff = (out[tfo+1]<<16) | (out[tfo+2]<<8) | out[tfo+3];
        let tp = tfo + 4;
        tp += 4; // track_ID
        if (ff & 0x01) { baseOff = u64(out, tp); tp += 8; } // base-data-offset present
        // other defaults ignored
      }
      baseOff += dataOffset; // absolute byte offset of first sample in the segment
      if (baseOff < 0 || baseOff >= out.length) continue;

      // --- read per-sample dur/size/flags/cts ---
      const sampleSizes = new Uint32Array(sampleCount);
      for (let s=0; s<sampleCount; s++) {
        if (haveDur) p += 4;
        if (haveSize) { sampleSizes[s] = u32(out, p); p += 4; }
        if (haveFlags) p += 4;
        if (haveCts) p += 4;
      }

      // compute absolute offset of each sample
      const offsets = new Uint32Array(sampleCount);
      let cur = baseOff;
      for (let s=0; s<sampleCount; s++) {
        offsets[s] = cur;
        cur += sampleSizes[s];
      }

      // --- Read IVs + subsample ranges ---
      let ivs = [];
      let perSampleIvPrefix = false;
      if (senc) {
        ivs = parseSenc(out, senc, ivSize, sampleCount);
      } else {
        // IVs prefix each sample in mdat (cenc 'cenc' with in-band IVs)
        perSampleIvPrefix = true;
        let pp = baseOff;
        for (let s=0; s<sampleCount; s++) {
          const iv = Buffer.alloc(16);
          out.copy(iv, 0, pp, pp + ivSize);
          pp += ivSize;
          offsets[s] += ivSize;
          sampleSizes[s] -= ivSize;
          pp += sampleSizes[s];
          ivs.push({ iv, subsamples: [] });
        }
      }

      // --- Decrypt per CENC AES-CTR rules ---
      // CENC AES-CTR: IV is 16 bytes = (8-byte big-endian IV in high bytes) | (8-byte block counter BE in low bytes)
      // Block counter increments on each 16-byte AES block WITHIN a single encrypted range; it resets per encrypted range.
      // Clear (unencrypted) bytes are copied as-is.
      for (let s=0; s<sampleCount; s++) {
        const iv = ivs[s]?.iv;
        if (!iv) continue;
        const off = offsets[s];
        const sz  = sampleSizes[s];
        if (!sz || off + sz > out.length) continue;
        const subs = ivs[s].subsamples;

        if (!subs || subs.length === 0) {
          // full-sample encryption
          const enc = out.subarray(off, off + sz);
          const d = createDecipheriv('aes-128-ctr', key, iv);
          d.setAutoPadding(false);
          const dec = Buffer.concat([d.update(enc), d.final()]);
          dec.copy(out, off, 0, dec.length);
        } else {
          // subsample encryption: walk subsamples, decrypt encrypted ranges
          let pos = off;
          for (let sb=0; sb<subs.length; sb++) {
            const { clearBytes, encryptedBytes } = subs[sb];
            pos += clearBytes; // leave clear bytes untouched
            if (encryptedBytes > 0) {
              if (pos + encryptedBytes > out.length) break;
              const enc = out.subarray(pos, pos + encryptedBytes);
              // For CENC pattern cenc: block counter starts at 0 for each encrypted range.
              // We create a fresh decipher per encrypted range so counter resets to 0.
              const rangeIv = Buffer.from(iv); // copy of the IV (block counter = 0 in low 8 bytes)
              const d = createDecipheriv('aes-128-ctr', key, rangeIv);
              d.setAutoPadding(false);
              const dec = Buffer.concat([d.update(enc), d.final()]);
              dec.copy(out, pos, 0, dec.length);
              pos += encryptedBytes;
            }
          }
        }
      }
    }
  }
  return out;
}

export function codecString (stsdEntry) {
  // Build RFC 6381-ish codec string for mux.js codec config (mux.js needs codec string + extradata)
  const { codec } = stsdEntry;
  if (codec.startsWith('avc')) {
    // avc1.PPCCLL (hex profile/constraints/level)
    const cfg = stsdEntry.avcC;
    if (cfg && cfg.length >= 4) {
      const prof = cfg[1].toString(16).padStart(2,'0');
      const cons = cfg[2].toString(16).padStart(2,'0');
      const lvl  = cfg[3].toString(16).padStart(2,'0');
      return `avc1.${prof}${cons}${lvl}`;
    }
    return 'avc1.4D401F';
  }
  if (codec === 'mp4a') {
    // mp4a.40.d — for AAC-LC (2) => mp4a.40.2; HE-AACv1 (5); HE-AACv2 (29)
    // We'll default to mp4a.40.2 but can refine from esds
    return 'mp4a.40.2';
  }
  return codec;
}
