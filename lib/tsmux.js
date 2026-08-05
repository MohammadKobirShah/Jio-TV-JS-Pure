/**
 * Minimal MPEG-2 TS muxer for JStar Pure-JS v4 ☕
 *
 * Generates PAT/PMT and packetizes pre-parsed H.264 (AVC) + AAC elementary streams.
 * - 188-byte TS packets, 0x47 sync byte
 * - Video PID 0x100, Audio PID 0x101, PMT PID 0x1000, PAT 0x0000
 * - PES packets for access units
 * - PCR stamped on video stream
 * - Handles adaptation field stuffing
 *
 * Inputs are plain Byte-Arrays of already-demuxed NALUs (H.264) or AAC frames (raw AAC frame data, ADTS headers added).
 */

const TS_PACKET_SIZE = 188;
const SYNC = 0x47;

// PID assignments
const PID_PAT   = 0x0000;
const PID_PMT   = 0x1000;
const PID_VIDEO = 0x0100;
const PID_AUDIO = 0x0101;

// Stream types
const STREAM_TYPE_H264 = 0x1B;
const STREAM_TYPE_AAC  = 0x0F; // ADTS AAC in LATM? actually 0x0F = AAC in PES per ISO/IEC 13818-7 (ADTS)
const STREAM_TYPE_AAC_LATM = 0x11;

// Continuity counters per PID
const cc = { [PID_PAT]: 0, [PID_PMT]: 0, [PID_VIDEO]: 0, [PID_AUDIO]: 0 };

function incrementCC (pid) {
  cc[pid] = (cc[pid] + 1) & 0x0F;
}

function crc32 (buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) crc = (crc >>> 1) ^ 0xEDB88320;
      else crc >>>= 1;
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function writeU16 (buf, off, v) { buf[off] = v >> 8; buf[off+1] = v & 0xFF; }
function writeU32 (buf, off, v) { buf[off] = (v>>>24)&0xFF; buf[off+1]=(v>>>16)&0xFF; buf[off+2]=(v>>>8)&0xFF; buf[off+3]=v&0xFF; }

// Build PAT section
// PAT section layout (bytes):
//   table_id(1) = 0x00
//   section_syntax_indicator(1)='1' + '0' + reserved(2)='11' + section_length(12)
//   transport_stream_id(2) + reserved(2)+version(5)+current(1) + section_number(1) + last_section(1)
//   for each program: program_number(2) + reserved(3) + program_map_PID(13)
//   CRC_32(4)
export function buildPAT () {
  // Programs
  const programs = [{ num: 1, pmtPid: PID_PMT }];
  const progLoopLen = programs.length * 4;
  const sectionLen = 5 + progLoopLen + 4; // before_crc(5) + loop + crc(4)
  const buf = Buffer.alloc(3 + sectionLen); // table_id(1)+syntax/sl(2)+section
  let p = 0;
  buf[p++] = 0x00;
  // section_syntax=1, '0', reserved=0x3000, section_length
  const sl1 = 0xB000 | (sectionLen & 0x0FFF);
  writeU16(buf, p, sl1); p += 2;
  writeU16(buf, p, 1); p += 2; // transport_stream_id=1
  buf[p++] = 0xC1; // version=0(5bits)<<1 | current=1 -> 0b11000001 = C1
  buf[p++] = 0;
  buf[p++] = 0;
  for (const pr of programs) {
    writeU16(buf, p, pr.num); p += 2;
    writeU16(buf, p, 0xE000 | pr.pmtPid); p += 2;
  }
  const crcData = buf.slice(0, p);
  writeU32(buf, p, crc32(crcData)); p += 4;
  return buf.slice(0, p);
}

// Build PMT section for one video + one audio program
export function buildPMT (videoStreamType, audioStreamType) {
  const streams = [];
  if (videoStreamType) streams.push({ st: videoStreamType, pid: PID_VIDEO });
  if (audioStreamType) streams.push({ st: audioStreamType, pid: PID_AUDIO });
  const progInfoLen = 0;
  const streamLoopLen = streams.length * 5; // 1+2+2 per stream (no ES descriptors)
  const sectionLen = 9 + streamLoopLen + 4; // before_prog_loop(9 = tsid...prog_info_len) + streams + CRC
  const buf = Buffer.alloc(3 + sectionLen);
  let p = 0;
  buf[p++] = 0x02; // table_id=PMT
  writeU16(buf, p, 0xB000 | (sectionLen & 0x0FFF)); p += 2;
  writeU16(buf, p, 1); p += 2; // program_number=1
  buf[p++] = 0xC1; // version+current
  buf[p++] = 0;
  buf[p++] = 0;
  writeU16(buf, p, 0xE000 | PID_VIDEO); p += 2; // PCR_PID
  writeU16(buf, p, 0xF000 | progInfoLen); p += 2; // program_info_length
  for (const s of streams) {
    buf[p++] = s.st;
    writeU16(buf, p, 0xE000 | s.pid); p += 2;
    writeU16(buf, p, 0xF000 | 0); p += 2; // ES_info_length=0
  }
  const crcData = buf.slice(0, p);
  writeU32(buf, p, crc32(crcData)); p += 4;
  return buf.slice(0, p);
}

// Build TS packets for a PSI section (PAT or PMT), each packet has pointer_field=0 then section data, stuffing with 0xFF.
export function psiPackets (pid, sectionBuf) {
  const ccStart = cc[pid];
  const out = [];
  let remaining = sectionBuf.length;
  let off = 0;
  let first = true;
  while (remaining > 0 || first) {
    const pkt = Buffer.alloc(TS_PACKET_SIZE, 0xFF);
    let p = 0;
    pkt[p++] = SYNC;
    // PID + TEI(0)+PUSI(1)+priority(0) = 0x4000 | pid
    const high = 0x40 | ((pid >> 8) & 0x1F); // TEI=0, PUSI=1 for first packet of section
    pkt[p++] = high;
    pkt[p++] = pid & 0xFF;
    // continuity counter (with payload only)
    pkt[p++] = 0x10 | (cc[pid] & 0x0F); // payload_unit_start_indicator=1 in second byte? Wait PUSI is in byte 1 bit 6. We set it above.
    incrementCC(pid);
    // pointer_field = 0
    pkt[p++] = 0;
    if (first) { first = false; }
    const avail = TS_PACKET_SIZE - p;
    const toCopy = Math.min(avail, remaining);
    if (toCopy > 0) {
      sectionBuf.copy(pkt, p, off, off + toCopy);
      off += toCopy; remaining -= toCopy; p += toCopy;
    }
    out.push(pkt);
  }
  return out;
}

// Build PES packet for one access unit, then fragment into TS packets.
// pesData is the encoded video/audio bytes with appropriate start codes already prefixed.
// pts: 90kHz timestamp
// dts: 90kHz timestamp (same as pts for audio; or passed separately for video with B-frames)
// randomAccess: true for IDR/key frames
export function pesPackets (pid, isVideo, pesData, pts, dts, randomAccess) {
  const hasPts = pts != null;
  const hasDts = dts != null && dts !== pts;
  const headerLen = 3 + 1 + (hasPts ? 5 : 0) + (hasDts ? 5 : 0);
  const pesLen = Math.min(pesData.length + headerLen, 0xFFFF); // 0 for video when unknown
  const totalPesPayloadLen = pesData.length;
  const buf = Buffer.alloc(9 + headerLen + totalPesPayloadLen);
  let p = 0;
  // PES start code prefix
  buf[p++] = 0x00; buf[p++] = 0x00; buf[p++] = 0x01;
  // stream_id
  buf[p++] = isVideo ? 0xE0 : 0xC0;
  // PES packet length
  const lenField = 0; // 0 => not constrained (standard for video)
  writeU16(buf, p, lenField); p += 2;
  // PES header flags
  buf[p++] = 0x80 | (hasDts ? 0x40 : 0x80); // marker bits + PTS-only or PTS+DTS
  // Actually standard: 10 + PES_scrambling + priority + alignment + copyright + original
  // marker(2)=10, scrambling(2)=00, priority(1)=0, alignment(1)=1 if randomAccess, copyright=0, original=0
  let flags1 = 0x80; // marker bits '10' in top 2 bits
  if (randomAccess) flags1 |= 0x04; // data_alignment_indicator
  buf[p-1] = flags1;
  // PTS/DTS flags
  let flags2 = (hasDts ? 0xC0 : 0x80);
  buf[p++] = flags2;
  buf[p++] = headerLen - 3; // PES_header_data_length
  // PTS/DTS
  const writeTs = (buf, off, ts, tagHigh4) => {
    // [4bits tag][3bits ts32..30][1b marker][15b ts29..15][1b marker][15b ts14..0][1b marker]
    buf[off]   = tagHigh4 | (((ts >> 29) & 0x07) << 1) | 0x01;
    buf[off+1] = ((ts >> 22) & 0xFF) << 0;
    buf[off+2] = (((ts >> 14) & 0xFF) << 0) | 0x01;
    buf[off+3] = (ts >> 7) & 0xFF;
    buf[off+4] = (((ts) & 0x7F) << 1) | 0x01;
  };
  if (hasPts && !hasDts) {
    writeTs(buf, p, pts, 0x20); p += 5;
  } else if (hasPts && hasDts) {
    writeTs(buf, p, pts, 0x30); p += 5;
    writeTs(buf, p, dts, 0x10); p += 5;
  }
  // copy payload
  pesData.copy(buf, p, 0, totalPesPayloadLen);
  p += totalPesPayloadLen;
  const pes = buf.slice(0, p);

  // Fragment into TS packets
  const out = [];
  let off = 0;
  let first = true;
  while (off < pes.length) {
    const pkt = Buffer.alloc(TS_PACKET_SIZE, 0xFF);
    let hp = 0;
    pkt[hp++] = SYNC;
    let flags = 0;
    // adaptation control: 01 (payload only) or 11 if need PCR (first packet of PES on video)
    let adaptationControl = 0x01;
    let afLen = 0;
    if (first) flags |= 0x40; // payload_unit_start_indicator
    if (first && isVideo && randomAccess) {
      // Insert PCR in adaptation field
      // Need PCR which is same as PTS scaled to 27MHz: pcr = pts*300
      const pcrBase = pts != null ? pts * 300 : 0;
      // adaptation field: length(1) + flags(1) + pcr(6)
      afLen = 7;
      adaptationControl = 0x03; // adaptation + payload
      // we'll place after header
    }
    pkt[hp++] = flags | ((pid >> 8) & 0x1F);
    pkt[hp++] = pid & 0xFF;
    pkt[hp++] = 0x10 | (cc[pid] & 0x0F);
    incrementCC(pid);
    let pPos = hp;
    if (adaptationControl & 0x02) {
      // Write adaptation field
      pkt[hp++] = afLen; // adaptation_field_length
      pkt[hp++] = 0x10; // flags: random_access_indicator? 0x40 for key, PCR_flag=0x10
      if (randomAccess) pkt[hp-1] |= 0x40;
      pkt[hp-1] |= 0x10; // PCR_flag
      // PCR: 33 bits base + 6 bits reserved + 9 bits extension
      const pcrBase = (pts||0) * 300;
      const pcrExt = 0;
      // base is encoded as 33 bits: 6 bytes (split into 32+1 with marker bits)
      pkt[hp++] = (pcrBase >>> 25) & 0xFF;
      pkt[hp++] = (pcrBase >>> 17) & 0xFF;
      pkt[hp++] = (pcrBase >>> 9) & 0xFF;
      pkt[hp++] = (pcrBase >>> 1) & 0xFF;
      pkt[hp++] = ((pcrBase & 1) << 7) | 0x7E | ((pcrExt >>> 8) & 0x01);
      pkt[hp++] = pcrExt & 0xFF;
      // Stuffing rest of adaptation field with 0xFF — already filled
    }
    const payloadStart = hp;
    const headerConsumed = hp;
    const payloadAvail = TS_PACKET_SIZE - headerConsumed;
    let toCopy = Math.min(payloadAvail, pes.length - off);
    pes.copy(pkt, payloadStart, off, off + toCopy);
    off += toCopy;
    // If first and remaining < payloadAvail, stuffing is already 0xFF
    out.push(pkt);
    first = false;
  }
  return out;
}

// Helper: convert an array of TS packets into one Buffer
export function concatPackets (packets) {
  return Buffer.concat(packets);
}

export class TSMuxer {
  constructor () {
    this.patWritten = false;
    this.pmtWritten = false;
    this.pcrPid = PID_VIDEO;
    this.chunks = [];
    this.hasVideo = false;
    this.hasAudio = false;
  }

  setHasVideo (v) { this.hasVideo = v; }
  setHasAudio (v) { this.hasAudio = v; }

  writePSI () {
    const pat = buildPAT();
    const patPkts = psiPackets(PID_PAT, pat);
    this.chunks.push(...patPkts);
    const pmt = buildPMT(this.hasVideo ? STREAM_TYPE_H264 : 0, this.hasAudio ? STREAM_TYPE_AAC : 0);
    const pmtPkts = psiPackets(PID_PMT, pmt);
    this.chunks.push(...pmtPkts);
    this.patWritten = true;
    this.pmtWritten = true;
  }

  writeVideo (pesData, pts, dts, isKeyframe) {
    if (!this.patWritten) this.writePSI();
    const pkts = pesPackets(PID_VIDEO, true, pesData, pts, dts, isKeyframe);
    this.chunks.push(...pkts);
  }

  writeAudio (pesData, pts) {
    if (!this.patWritten) this.writePSI();
    const pkts = pesPackets(PID_AUDIO, false, pesData, pts, pts, false);
    this.chunks.push(...pkts);
  }

  consume () {
    const out = Buffer.concat(this.chunks);
    this.chunks = [];
    return out;
  }

  getSize () { return this.chunks.reduce((a,p)=>a+p.length,0); }
}

// --- H.264 / AAC helpers ---

// Convert AVC decoder configuration record + NALUs into Annex-B byte stream
// avcC is the raw avcC box (starts with version byte at .offset).
export function buildAnnexBFromAvcc (avcC) {
  // avcC layout:
  //  0: configurationVersion
  //  1: AVCProfileIndication
  //  2: profile_compatibility
  //  3: AVCLevelIndication
  //  4: lengthSizeMinusOne (low 2 bits)
  //  5: numOfSequenceParameterSets (low 5 bits)
  //  for each SPS: 2 bytes length, then data
  //  1 byte numOfPictureParameterSets
  //  for each PPS: 2 bytes length, then data
  const startCode = Buffer.from([0,0,0,1]);
  const pieces = [];
  const lengthSize = (avcC[4] & 0x03) + 1; // usually 4
  let p = 5;
  const numSps = avcC[p] & 0x1F; p++;
  for (let i=0;i<numSps;i++) {
    const spsLen = (avcC[p]<<8)|avcC[p+1]; p+=2;
    pieces.push(startCode, avcC.slice(p, p+spsLen));
    p += spsLen;
  }
  const numPps = avcC[p] & 0x1F; p++;
  for (let i=0;i<numPps;i++) {
    const ppsLen = (avcC[p]<<8)|avcC[p+1]; p+=2;
    pieces.push(startCode, avcC.slice(p, p+ppsLen));
    p += ppsLen;
  }
  return Buffer.concat(pieces);
}

// Convert one sample's data (length-prefixed NALUs) into Annex-B with 00 00 00 01 start codes.
// If prependSpsPps is provided (Annex-B SPS/PPS), prepend that (use for IDR samples).
export function sampleToAnnexB (sampleBuf, lengthSize, prependSpsPps) {
  const pieces = [];
  if (prependSpsPps) pieces.push(prependSpsPps);
  const startCode = Buffer.from([0,0,0,1]);
  let p = 0;
  while (p < sampleBuf.length) {
    let len = 0;
    for (let i=0;i<lengthSize;i++) len = (len<<8) | sampleBuf[p+i];
    p += lengthSize;
    if (len <= 0 || p+len > sampleBuf.length) break;
    pieces.push(startCode, sampleBuf.slice(p, p+len));
    p += len;
  }
  return Buffer.concat(pieces);
}

// Build ADTS header for one AAC frame given sampleRate, channels
// AAC profile defaults to AAC-LC (profile=1), samplingFrequencyIndex from table, channelConfig.
const AAC_SAMPLE_RATES = [96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];
export function aacToADTS (aacFrame, sampleRate, channels, aacProfile = 2 /* AAC-LC = 2, so audioObjectType-1 = 1 */) {
  const freqIdx = AAC_SAMPLE_RATES.indexOf(sampleRate);
  if (freqIdx < 0) throw new Error('unsupported samplerate '+sampleRate);
  const frameLen = aacFrame.length + 7; // 7 byte ADTS header
  const hdr = Buffer.alloc(7);
  hdr[0] = 0xFF;
  hdr[1] = 0xF1; // MPEG4, no CRC, layer 0
  // profile(2 bits) = aacProfile-1 (AAC-LC=1), freqIdx(4), private(1), channelCfg high(1)
  hdr[2] = ((aacProfile-1) << 6) | (freqIdx << 2) | ((channels >> 2) & 0x01);
  // channelCfg low(2), frameLen high 2 bits, buffer fullness(1 bit)
  hdr[3] = ((channels & 0x03) << 6) | ((frameLen >> 11) & 0x03) | 0x00;
  hdr[4] = (frameLen >> 3) & 0xFF;
  hdr[5] = ((frameLen & 0x07) << 5) | 0x1F; // buffer fullness 0x7FF
  hdr[6] = 0xFC; // buffer fullness low bits + 0 frames in RDB
  return Buffer.concat([hdr, aacFrame]);
}
