// LiveKit recorder for Node: subscribes to 'callee' and 'agent' tracks,
// mixes to mono PCM16 (48kHz) and writes a WAV file.

const fs = require('fs');
const path = require('path');

const wrtc = (() => {
  try { return require('wrtc'); } catch { return null; }
})();
const WS = (() => {
  try { return require('ws'); } catch { return null; }
})();

function toWsUrl(httpish) {
  if (!httpish) return null;
  if (httpish.startsWith('ws://') || httpish.startsWith('wss://')) return httpish;
  if (httpish.startsWith('https://')) return 'wss://' + httpish.slice('https://'.length);
  if (httpish.startsWith('http://')) return 'ws://' + httpish.slice('http://'.length);
  return httpish;
}

function writeWavHeader(fd, sampleRate, channels) {
  const bitsPerSample = 16;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(0, 4); // placeholder
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(0, 40); // placeholder
  fs.writeSync(fd, header, 0, 44, 0);
}

function finalizeWav(fd, totalBytes) {
  const dataSize = Math.max(0, totalBytes - 44);
  const fileSize = dataSize + 36;
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(fileSize, 0);
  fs.writeSync(fd, buf, 0, 4, 4);
  buf.writeUInt32LE(dataSize, 0);
  fs.writeSync(fd, buf, 0, 4, 40);
}

async function createRecorder({ host, token, roomName, outFileBase }) {
  if (!wrtc) {
    console.warn('[LiveKit] wrtc not installed; recorder disabled');
    return null;
  }
  // Prepare Node env for livekit-client
  if (typeof globalThis.navigator === 'undefined') globalThis.navigator = { userAgent: 'node' };
  if (!globalThis.WebSocket && WS) globalThis.WebSocket = WS;
  const lk = await import('livekit-client');
  if (typeof lk.setWebRTC === 'function') lk.setWebRTC(wrtc);
  else if (lk.default && typeof lk.default.setWebRTC === 'function') lk.default.setWebRTC(wrtc);
  if (typeof lk.setWebSocket === 'function' && WS) lk.setWebSocket(WS);
  else if (lk.default && typeof lk.default.setWebSocket === 'function' && WS) lk.default.setWebSocket(WS);

  const room = new lk.Room();
  const url = toWsUrl(host);
  await room.connect(url, token);

  // Prepare WAV output (mono 48kHz PCM16)
  const recordingsDir = path.resolve(__dirname, '..', '..', 'recordings');
  if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });
  const outPath = path.join(recordingsDir, `${outFileBase}.wav`);
  const fd = fs.openSync(outPath, 'w');
  writeWavHeader(fd, 48000, 1);
  let bytesWritten = 44;

  // Sinks for remote tracks
  const { RTCAudioSink } = (wrtc && wrtc.nonstandard) || {};
  const activeSinks = new Map(); // key: 'callee'|'agent'

  // Simple mixing: sum samples with soft clip
  function mixAndWrite(frameMap) {
    // Expect Int16Array at 48k; if Float32, convert first
    let a = frameMap.get('agent');
    let c = frameMap.get('callee');
    if (!a && !c) return;
    const len = Math.max(a ? a.length : 0, c ? c.length : 0);
    const out = new Int16Array(len);
    for (let i = 0; i < len; i++) {
      const va = a ? (a[i] || 0) : 0;
      const vc = c ? (c[i] || 0) : 0;
      let sum = va + vc;
      if (sum > 32767) sum = 32767;
      if (sum < -32768) sum = -32768;
      out[i] = sum;
    }
    const buf = Buffer.from(out.buffer);
    fs.writeSync(fd, buf);
    bytesWritten += buf.length;
  }

  // Frame queues by track name
  const frameQueues = new Map();
  frameQueues.set('agent', []);
  frameQueues.set('callee', []);

  function drain() {
    const haveA = frameQueues.get('agent').length > 0;
    const haveC = frameQueues.get('callee').length > 0;
    const frameMap = new Map();
    if (haveA) frameMap.set('agent', frameQueues.get('agent').shift());
    if (haveC) frameMap.set('callee', frameQueues.get('callee').shift());
    if (frameMap.size) mixAndWrite(frameMap);
  }

  function onTrack(track, publication) {
    if (track.kind !== 'audio') return;
    const name = publication && (publication.trackName || publication.sid) || 'audio';
    if (!RTCAudioSink) return;
    const sink = new RTCAudioSink(track.mediaStreamTrack);
    activeSinks.set(name, sink);
    sink.addEventListener('data', (e) => {
      // e: { sampleRate, bitsPerSample, numberOfChannels, numberOfFrames, samples: Int16Array|Float32Array }
      try {
        // Convert to Int16Array at 48k mono
        let samples = e.samples;
        if (samples instanceof Float32Array) {
          const int16 = new Int16Array(samples.length);
          for (let i = 0; i < samples.length; i++) {
            let v = Math.max(-1, Math.min(1, samples[i]));
            int16[i] = v < 0 ? v * 32768 : v * 32767;
          }
          samples = int16;
        }
        frameQueues.get(name)?.push(samples);
        drain();
      } catch (err) {
        console.error('[LiveKit] recorder sink error:', err);
      }
    });
  }

  room.on(lk.RoomEvent.TrackSubscribed, onTrack);
  // If already subscribed (late join), attach
  room.remoteParticipants.forEach((p) => p.tracks.forEach((pub) => pub.track && onTrack(pub.track, pub)));

  async function close() {
    try {
      for (const sink of activeSinks.values()) {
        try { sink.stop(); } catch {}
      }
      activeSinks.clear();
      await room.disconnect();
    } finally {
      try { finalizeWav(fd, bytesWritten); } catch {}
      try { fs.closeSync(fd); } catch {}
    }
    return outPath;
  }

  return { close, outPath };
}

module.exports = { createRecorder, toWsUrl };

