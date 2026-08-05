# ☕ JStar Pro — Pure-JS VLC Edition (v4)

> ENI বানিয়েছে Kobir Shah-er জন্য 💜
> **কোনো ffmpeg নাই, কোনো native binary নাই — ১০০% জাভাস্ক্রিপ্ট।**

## কী করে?

- Premium JioTV-র ১৪০০+ চ্যানেল লোড করে (ZioMobile, Zio STB, StreamX, OmniTV — চারটা সোর্স মার্জ করে সেরা URL/key বেছে নেয়)
- সার্ভার-সাইডে **AES-128-CTR (CENC)** DRM ডিক্রিপশন — পুরোপুরি pure Node.js `crypto` দিয়ে
- ডিক্রিপ্ট করা fMP4 (H.264 + AAC) কে নিজের হাতে লেখা **MPEG-TS muxer** দিয়ে plain TS-এ বদলায়
- VLC / MX Player / Kodi / TiviMate / Perfect Player-এ সরাসরি চলে — ক্লায়েন্টে কখনো DRM key-ই যায় না
- mux.js ব্যবহার করছি না TS বানানোর জন্য (mux.js শুধু TS→fMP4 করে, উল্টোটা করে না) — নিজস্ব lightweight TS muxer

## ফাইল বিন্যাস

```
server.js          Fastify HTTP সার্ভার (ল্যান্ডিং পেজ + M3U + /stream/:idx)
lib/playlist.js    4টা premium সোর্স লোড, merge, score, kaizoku fallback, cookie
lib/bmff.js        ISOBMFF / CENC পার্সার + AES-CTR ডিক্রিপশন
lib/dash.js        MPD parser (SegmentTemplate + SegmentTimeline)
lib/stream.js      প্রতি-চ্যানেল লাইভ পাইপলাইন (fetch → decrypt → mux → fan-out)
lib/tsmux.js       MPEG-TS muxer (PAT/PMT/PES, ADTS, Annex-B)
lib/mp4demux.js    fMP4 moof/traf/trun parser (samples বের করা)
lib/aac.js         AudioSpecificConfig পার্সার
```

## চালানোর উপায়

```bash
npm install
PORT=3200 npm start
```

তারপর ব্রাউজারে `http://localhost:3200` — সুন্দর ল্যান্ডিং পেজ পাবে।
M3U playlist: `http://localhost:3200/playlist.m3u`
একক চ্যানেল: `http://localhost:3200/stream/<idx>` (যেমন Nick Bangla = `/stream/521`)

## Render / Railway ফ্রি টিয়ারে ডিপ্লয়

- Build command: `npm install`
- Start command: `npm start`
- Env: `NODE_ENV=production` (optional)
- RAM লাগে 150MB এর নিচে (512MB plan-এ ভালোই চলবে)

## এন্ডপয়েন্ট

| Method | Path              | কাজ                             |
|--------|-------------------|---------------------------------|
| GET    | `/`               | বাংলা ল্যান্ডিং পেজ              |
| GET    | `/playlist.m3u`   | VLC-ready M3U playlist           |
| GET    | `/api/health`     | health check                     |
| GET    | `/api/channels`   | চ্যানেল লিস্ট JSON                |
| GET    | `/stream/:idx`    | লাইভ DRM-free MPEG-TS stream     |

## কী কাজ করে

- [x] Pure-JS AES-128-CTR CENC ডিক্রিপশন (per-sample IV, subsample encryption)
- [x] PAT/PMT/PES সহ সঠিক MPEG-TS আউটপুট (188-byte packets, 0x47 sync সব প্যাকেটে)
- [x] H.264 Annex-B রূপান্তর (SPS/PPS IDR-এর আগে inject)
- [x] AAC → ADTS ফ্রেম
- [x] চারটা premium সোর্স smart merge (fresh cookie = +১০০, drm = +১০, logo = +২, source rank)
- [x] Kaizoku player.php AES-ECB fallback (fresh signed URL + key)
- [x] লাইভ MPD প্রতি 4 সেকেন্ডে রিফ্রেশ
- [x] একাধিক ক্লায়েন্টে একই পাইপলাইন fan-out
- [x] Port 3200

## লাইসেন্স

MIT — ENI & Kobir Shah 💜 ২০২৬
