/**
 * AAC minimal helpers:
 *  - Parse AudioSpecificConfig (2 bytes) to get audioObjectType, sampleRate, channels
 *  - Build ADTS frame headers
 */

const SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
  16000, 12000, 11025, 8000, 7350, 0, 0, 0
];

// AudioSpecificConfig is 2+ bytes:
//   audioObjectType (5 bits), samplingFreqIndex (4 bits), channelConfig (4 bits),
//   ... (GASpecificConfig follows but we only need these three)
export function parseASC (buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  let aot = b0 >> 3;
  let freqIdx = ((b0 & 0x07) << 1) | (b1 >> 7);
  let channels = (b1 >> 3) & 0x0F;
  if (freqIdx === 0x0F) {
    // explicit sample rate (24 bits)
    if (buf.length < 5) return null;
    const sr = ((buf[1] & 0x7F) << 17) | (buf[2] << 9) | (buf[3] << 1) | (buf[4] >> 7);
    return { aot, sampleRate: sr, channels };
  }
  return { aot, sampleRate: SAMPLE_RATES[freqIdx] || 44100, channels };
}

// Find AudioSpecificConfig inside esds box in init segment (for mp4a/enca entries)
export function findASCFromEsds (initBuf, stsdEntry) {
  if (!stsdEntry?.esds) return null;
  const esds = stsdEntry.esds;
  // esds box payload: version(1)+flags(3)+ES_Descriptor
  let p = 4; // skip v+flags
  // ES_Descriptor tag=0x03, length(1-4 bytes), ES_ID(2), flags(1), then decConfigDescr tag=0x04
  while (p < esds.length - 4) {
    const tag = esds[p];
    p++;
    // Read variable-length length
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const b = esds[p]; p++;
      len = (len << 7) | (b & 0x7F);
      if (!(b & 0x80)) break;
    }
    if (tag === 0x04) {
      // DecoderConfigDescriptor: objectTypeIndication(1), streamType(1), bufferSize(3), maxBitrate(4), avgBitrate(4), then DecoderSpecificInfo tag=0x05
      p += 1 + 1 + 3 + 4 + 4;
      const tag2 = esds[p]; p++;
      let len2 = 0;
      for (let i = 0; i < 4; i++) {
        const b = esds[p]; p++;
        len2 = (len2 << 7) | (b & 0x7F);
        if (!(b & 0x80)) break;
      }
      if (tag2 === 0x05) {
        return Buffer.from(esds.slice(p, p + len2));
      }
      return null;
    }
    p += len;
  }
  return null;
}
