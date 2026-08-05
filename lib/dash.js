/**
 * Minimal DASH MPD parser (live, SegmentTimeline+SegmentTemplate only — Broadpeak BkS350).
 * Returns arrays of video/audio Representation objects with init/media templates + timeline.
 *
 * We don't aim to be a full MPD parser — just enough for Jio BkS350 live manifests which use:
 *    <SegmentTemplate timescale=... initialization="...init..." media="...seg..." >
 *        <SegmentTimeline>
 *            <S t= d= r=/> ...
 *        </SegmentTimeline>
 *    </SegmentTemplate>
 */

export function parseAttr (str, name) {
  // Match attr="value", ensuring we don't match a suffix of another attribute (e.g. `id` in `bandwidth`).
  const re = new RegExp(`(?:^|[\\s])${name}="([^"]*)"`);
  const m = str.match(re);
  return m ? m[1] : '';
}

function resolveUrl (rel, base) {
  try { return new URL(rel, base).href; } catch { return rel; }
}

function expandTimeline (segs, timescale) {
  const list = [];
  let t = null;
  for (const s of segs) {
    if (s.t !== null && s.t !== undefined) t = s.t;
    const d = s.d;
    const r = (s.r !== undefined && s.r !== null) ? s.r + 1 : 1;
    for (let i = 0; i < r; i++) {
      list.push({ time: t, d, t, dur: d, pts: t / timescale, durSec: d / timescale });
      t += d;
    }
  }
  return list;
}

function parseSegmentTemplate (xml, periodStart, baseUrl) {
  const stRe = /<SegmentTemplate[^>]*>[\s\S]*?<\/SegmentTemplate>|<SegmentTemplate[^>]*\/>/g;
  const reps = [];
  let m;
  while ((m = stRe.exec(xml)) !== null) {
    const block = m[0];
    const initTmpl = parseAttr(block, 'initialization');
    const mediaTmpl = parseAttr(block, 'media');
    const timescale = parseInt(parseAttr(block, 'timescale') || '1', 10);
    // <S t= d= r=/> inside <SegmentTimeline>
    const tlMatch = block.match(/<SegmentTimeline>([\s\S]*?)<\/SegmentTimeline>/);
    let timeline = [];
    if (tlMatch) {
      const sRe = /<S\b([^/]*)\/?>/g;
      let s; const segs = [];
      while ((s = sRe.exec(tlMatch[1])) !== null) {
        const attrs = s[1];
        const tStr = parseAttr(attrs, 't');
        const dStr = parseAttr(attrs, 'd');
        const rStr = parseAttr(attrs, 'r');
        segs.push({
          t: tStr ? parseInt(tStr, 10) : null,
          d: parseInt(dStr, 10),
          r: rStr ? parseInt(rStr, 10) : null
        });
      }
      timeline = expandTimeline(segs, timescale);
    }
    reps.push({ initTmpl, mediaTmpl, timescale, timeline });
  }
  return reps;
}

function parseAdaptationSets (xml, baseUrl) {
  const adapts = [];
  const re = /<AdaptationSet[^>]*>([\s\S]*?)<\/AdaptationSet>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const full = m[0];
    const ct = parseAttr(full, 'contentType') || '';
    const mime = parseAttr(full, 'mimeType') || '';
    const lang = parseAttr(full, 'lang') || '';
    const codecs = parseAttr(full, 'codecs') || '';
    // parse representations
    const repRe = /<Representation[^>]*>/g;
    let rm;
    const reps = [];
    while ((rm = repRe.exec(m[1])) !== null) {
      const rBlock = rm[0];
      const id = parseAttr(rBlock, 'id');
      const bw = parseInt(parseAttr(rBlock, 'bandwidth') || '0', 10);
      const w = parseInt(parseAttr(rBlock, 'width') || '0', 10);
      const h = parseInt(parseAttr(rBlock, 'height') || '0', 1);
      const repCodecs = parseAttr(rBlock, 'codecs') || codecs;
      reps.push({ id, bandwidth: bw, width: w, height: h, codecs: repCodecs });
    }
    // SegmentTemplate can be either on AdaptationSet or Representation. Jio BkS350 puts it on AdaptationSet.
    const tpl = parseSegmentTemplate(full, 0, baseUrl)[0];
    adapts.push({ contentType: ct, mimeType: mime, lang, codecs, reps, tpl });
  }
  return adapts;
}

export function parseManifest (xml, baseUrl) {
  const type = /type="dynamic"/.test(xml) ? 'dynamic' : 'static';
  // minBufferTime
  const minBuf = parseAttr(xml, 'minBufferTime') || 'PT2S';
  const mediaPres = parseAttr(xml, 'mediaPresentationDuration') || '';
  const adapts = parseAdaptationSets(xml, baseUrl);
  // pick one video rep (best bandwidth) and one audio rep (best)
  const video = adapts.filter(a => a.contentType === 'video' || /video/.test(a.mimeType))
    .map(a => a.reps.map(r => ({ ...r, tpl: a.tpl, mimeType: a.mimeType, type: 'video' }))).flat()
    .sort((x,y) => y.bandwidth - x.bandwidth)[0] || null;
  const audios = adapts.filter(a => a.contentType === 'audio' || /audio/.test(a.mimeType))
    .map(a => a.reps.map(r => ({ ...r, tpl: a.tpl, mimeType: a.mimeType, type: 'audio', lang: a.lang }))).flat();
  const audio = audios.sort((x,y) => y.bandwidth - x.bandwidth)[0] || null;
  return { type, minBuf, video, audio, adapts };
}

export function resolveTemplate (tmpl, repId, time) {
  // Replace $RepresentationID$ and $Time$ (and $Number$ not used here)
  let url = tmpl
    .replace(/\$RepresentationID\$/g, repId)
    .replace(/\$Time\$/g, time !== undefined ? String(time) : '')
    .replace(/\$Number[^$]*\$/g, '');
  return url;
}
