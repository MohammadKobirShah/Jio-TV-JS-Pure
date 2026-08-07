/**
 * Minimal fMP4 demuxer — enough to extract video/audio samples from a decrypted
 * media segment given its init segment.
 *
 * Uses trun / tfhd / tfdt from moof to compute each sample's size+offset.
 * Returns an array of {data, pts, dts, isKeyframe} in track timescale units.
 */
import { walkBoxes, findBox, u32, u64, u16 } from './bmff.js';

export function parseMoof (segBuf, initTrackInfo) {
  const moofs = [...walkBoxes(segBuf)].filter(b => b.type === 'moof');
  const mdats = [...walkBoxes(segBuf)].filter(b => b.type === 'mdat');
  if (!moofs.length || !mdats.length) return [];
  const samples = [];
  for (let mi = 0; mi < moofs.length; mi++) {
    const moof = moofs[mi];
    const mdat = mdats[mi] || mdats[0];
    // Find track id from tfhd (for matching init track)
    const trafs = findBox(segBuf, 'traf', moof.offset, moof.end);
    for (const traf of trafs) {
      const tfhd = findBox(segBuf, 'tfhd', traf.offset, traf.end)[0];
      if (!tfhd) continue;
      const trun = findBox(segBuf, 'trun', traf.offset, traf.end)[0];
      if (!trun) continue;
      const tfdt = findBox(segBuf, 'tfdt', traf.offset, traf.end)[0];

      // Parse tfhd (ISO 14496-12 §8.8.14)
      const tfhdFlags = (segBuf[tfhd.offset+1]<<16)|(segBuf[tfhd.offset+2]<<8)|segBuf[tfhd.offset+3];
      let tp = tfhd.offset + 4;
      const trackId = u32(segBuf, tp); tp += 4;
      // 0x00001 base-data-offset (64-bit)
      // 0x00002 sample-description-index (32-bit)  -- was missing!
      // 0x00008 default-sample-duration (32-bit)
      // 0x00010 default-sample-size (32-bit)
      // 0x00020 default-sample-flags (32-bit)
      // 0x20000 default-base-is-moof (flag only, no field)
      let baseDataOffset = null;
      if (tfhdFlags & 0x01) { baseDataOffset = u64(segBuf, tp); tp += 8; }
      if (tfhdFlags & 0x02) { tp += 4; } // skip sample-description-index
      let defaultSampleDur = 0, defaultSampleSize = 0, defaultSampleFlags = 0;
      if (tfhdFlags & 0x08) { defaultSampleDur = u32(segBuf, tp); tp += 4; }
      if (tfhdFlags & 0x10) { defaultSampleSize = u32(segBuf, tp); tp += 4; }
      if (tfhdFlags & 0x20) { defaultSampleFlags = u32(segBuf, tp); tp += 4; }

      // tfdt decode time (v0=32bit, v1=64bit)
      let decodeTime = 0;
      if (tfdt) {
        const tfdtVer = segBuf[tfdt.offset];
        if (tfdtVer === 1) decodeTime = u64(segBuf, tfdt.offset + 4);
        else decodeTime = u32(segBuf, tfdt.offset + 4);
      }

      // Parse trun
      const to = trun.offset;
      const trunFlags = (segBuf[to+1]<<16)|(segBuf[to+2]<<8)|segBuf[to+3];
      const sampleCount = u32(segBuf, to+4);
      let pp = to+8;
      let dataOffset = 0;
      if (trunFlags & 0x01) { dataOffset = segBuf.readInt32BE(pp); pp += 4; }
      let firstSampleFlags = 0;
      if (trunFlags & 0x04) { firstSampleFlags = u32(segBuf, pp); pp += 4; }
      const haveDur = !!(trunFlags & 0x100);
      const haveSize = !!(trunFlags & 0x200);
      const haveFlags = !!(trunFlags & 0x400);
      const haveCts = !!(trunFlags & 0x800);

      // Determine base data offset
      let baseOff;
      if (baseDataOffset != null) baseOff = baseDataOffset;
      else baseOff = moof.boxStart;
      baseOff += dataOffset;

      const trackSamples = [];
      let curOff = baseOff;
      let curDts = decodeTime;
      for (let s = 0; s < sampleCount; s++) {
        let dur = defaultSampleDur;
        let size = defaultSampleSize;
        let flags = defaultSampleFlags;
        let cts = 0;
        if (haveDur) { dur = u32(segBuf, pp); pp += 4; }
        if (haveSize) { size = u32(segBuf, pp); pp += 4; }
        // Per-sample flags. When trun flags bit 0x400 is set, an ind-flags field is
        // present for every sample; bit 0x004 additionally overrides the first sample's
        // flags (and is consumed separately before the per-sample loop).
        if (haveFlags) {
          if (s === 0 && (trunFlags & 0x004)) {
            flags = firstSampleFlags;
            // first-sample-flags has already been consumed (pp advanced past it);
            // do NOT also read a per-sample flags field for the first sample
            // (ISO 14496-12: when first-sample-flags is present, the first per-sample
            //  entry in trun applies to sample #2, not #1).
          } else {
            flags = u32(segBuf, pp); pp += 4;
          }
        } else if (s === 0 && (trunFlags & 0x004)) {
          flags = firstSampleFlags;
        }
        if (haveCts) {
          // signed i32 cts offset
          cts = segBuf.readInt32BE(pp); pp += 4;
        }
        // sampleFlags: bits 24-27 = sample_depends_on, bits 28-31 = is_leading
        // Keyframe when sample_depends_on == 2 (does not depend on others = 2? Wait values:
        //  0: unknown, 1: depends on others (not key), 2: does not depend (key), 3: reserved
        const dependsOn = (flags >> 24) & 0x03;
        const isKey = dependsOn === 2;
        const data = Buffer.from(segBuf.slice(curOff, curOff + size));
        trackSamples.push({
          trackId,
          data,
          dts: curDts,
          pts: curDts + cts,
          dur,
          isKey
        });
        curOff += size;
        curDts += dur;
      }
      samples.push(...trackSamples);
    }
  }
  return samples;
}

// Extract track timescale + codec info from init segment
export function parseInitTrack (initBuf, type /* 'video'|'audio' */) {
  const moov = findBox(initBuf, 'moov')[0];
  if (!moov) return null;
  const mvhd = findBox(initBuf, 'mvhd', moov.offset, moov.end)[0];
  const mvhdVer = initBuf[mvhd.offset];
  // mvhd: version+flags(4), ctime(4 or 8), mtime(4 or 8), timescale(4), duration(4 or 8)...
  let mp = mvhd.offset + 4;
  if (mvhdVer === 1) mp += 16; else mp += 8;
  const movieTimescale = u32(initBuf, mp);

  for (const trak of findBox(initBuf, 'trak', moov.offset, moov.end)) {
    const hdlr = findBox(initBuf, 'hdlr', trak.offset, trak.end)[0];
    const hdlrType = String.fromCharCode(initBuf[hdlr.offset+8],initBuf[hdlr.offset+9],initBuf[hdlr.offset+10],initBuf[hdlr.offset+11]);
    if (type === 'video' && hdlrType !== 'vide') continue;
    if (type === 'audio' && hdlrType !== 'soun') continue;
    const mdhd = findBox(initBuf, 'mdhd', trak.offset, trak.end)[0];
    const mdhdVer = initBuf[mdhd.offset];
    let dp = mdhd.offset + 4;
    if (mdhdVer === 1) dp += 16; else dp += 8;
    const timescale = u32(initBuf, dp);

    const stbl = findBox(initBuf, 'stbl', trak.offset, trak.end)[0];
    const stsd = findBox(initBuf, 'stsd', stbl.offset, stbl.end)[0];
    // Read first entry codec info using parseStsd from bmff
    // we return timescale
    return { trakHdlr: hdlrType, timescale, movieTimescale };
  }
  return null;
}
