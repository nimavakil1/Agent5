// LiveKit publisher for Node: publishes two audio tracks (callee, agent) into a room.
// Uses livekit-client (ESM) via dynamic import and wrtc's RTCAudioSource.

const wrtc = (() => {
  try {
    return require('wrtc');
  } catch (e) {
    return null;
  }
})();
const WS = (() => {
  try {
    return require('ws');
  } catch (e) {
    return null;
  }
})();

function toWsUrl(httpish) {
  if (!httpish) return null;
  if (httpish.startsWith('ws://') || httpish.startsWith('wss://')) return httpish;
  if (httpish.startsWith('https://')) return 'wss://' + httpish.slice('https://'.length);
  if (httpish.startsWith('http://')) return 'ws://' + httpish.slice('http://'.length);
  return httpish; // assume already ws(s)
}

async function createPublisher({ host, token, roomName }) {
  try {
    // Minimal globals expected by livekit-client in Node
    if (typeof globalThis.navigator === 'undefined') {
      globalThis.navigator = { userAgent: 'node' };
    }
    if (!globalThis.WebSocket && WS) {
      globalThis.WebSocket = WS;
    }
    if (!wrtc) {
      console.warn('[LiveKit] wrtc not installed; publisher disabled');
      return null;
    }
    const lk = await import('livekit-client');
    const wsUrl = toWsUrl(host);
    if (!wsUrl) {
      console.warn('[LiveKit] Invalid host for client connection');
      return null;
    }

    // Wire up WebRTC implementation for Node
    if (typeof lk.setWebRTC === 'function') {
      lk.setWebRTC(wrtc);
    } else if (lk.default && typeof lk.default.setWebRTC === 'function') {
      lk.default.setWebRTC(wrtc);
    } else {
      // try to set globals
      global.RTCPeerConnection = wrtc.RTCPeerConnection;
      global.RTCSessionDescription = wrtc.RTCSessionDescription;
      global.MediaStream = wrtc.MediaStream;
      global.MediaStreamTrack = wrtc.MediaStreamTrack;
    }
    if (typeof lk.setWebSocket === 'function' && WS) {
      lk.setWebSocket(WS);
    } else if (lk.default && typeof lk.default.setWebSocket === 'function' && WS) {
      lk.default.setWebSocket(WS);
    }

    const room = new lk.Room({
      publishDefaults: { dtx: true },
    });
    await room.connect(wsUrl, token);

    // Prepare audio sources and tracks
    const { RTCAudioSource } = wrtc.nonstandard || {};
    if (!RTCAudioSource) {
      console.warn('[LiveKit] RTCAudioSource unavailable; cannot publish audio');
      await room.disconnect();
      return null;
    }

    const calleeSource = new RTCAudioSource();
    const calleeTrack = calleeSource.createTrack();
    if (typeof calleeTrack.getConstraints !== 'function') {
      calleeTrack.getConstraints = () => ({});
    }
    if (typeof calleeTrack.getSettings !== 'function') {
      calleeTrack.getSettings = () => ({ sampleRate: 48000, channelCount: 1 });
    }
    await room.localParticipant.publishTrack(calleeTrack, { name: 'callee' });

    const agentSource = new RTCAudioSource();
    const agentTrack = agentSource.createTrack();
    if (typeof agentTrack.getConstraints !== 'function') {
      agentTrack.getConstraints = () => ({});
    }
    if (typeof agentTrack.getSettings !== 'function') {
      agentTrack.getSettings = () => ({ sampleRate: 48000, channelCount: 1 });
    }
    await room.localParticipant.publishTrack(agentTrack, { name: 'agent' });

    // Queues and timers for 10ms frames @ 48kHz (480 samples)
    let calleeQueue = Buffer.alloc(0); // int16 LE
    let agentQueue = Buffer.alloc(0);
    const FRAME_SAMPLES_48K = 480; // 10ms
    const FRAME_BYTES = FRAME_SAMPLES_48K * 2;
    let calleeTimer = null;
    let agentTimer = null;

    function startTimers() {
      if (!calleeTimer) {
        calleeTimer = setInterval(() => {
          try {
            if (calleeQueue.length >= FRAME_BYTES) {
              const frame = calleeQueue.subarray(0, FRAME_BYTES);
              calleeQueue = calleeQueue.subarray(FRAME_BYTES);
              const samples = new Int16Array(frame.buffer, frame.byteOffset, FRAME_SAMPLES_48K);
              calleeSource.onData({
                samples,
                sampleRate: 48000,
                numberOfFrames: FRAME_SAMPLES_48K,
                channelCount: 1,
              });
            }
          } catch (e) {
            console.error('[LiveKit] callee push error:', e);
          }
        }, 10);
      }
      if (!agentTimer) {
        agentTimer = setInterval(() => {
          try {
            if (agentQueue.length >= FRAME_BYTES) {
              const frame = agentQueue.subarray(0, FRAME_BYTES);
              agentQueue = agentQueue.subarray(FRAME_BYTES);
              const samples = new Int16Array(frame.buffer, frame.byteOffset, FRAME_SAMPLES_48K);
              agentSource.onData({
                samples,
                sampleRate: 48000,
                numberOfFrames: FRAME_SAMPLES_48K,
                channelCount: 1,
              });
            }
          } catch (e) {
            console.error('[LiveKit] agent push error:', e);
          }
        }, 10);
      }
    }

    startTimers();

    function upsampleInt16Nearest(int16, factor) {
      const out = new Int16Array(int16.length * factor);
      for (let i = 0; i < int16.length; i++) {
        const v = int16[i];
        const j = i * factor;
        for (let k = 0; k < factor; k++) out[j + k] = v;
      }
      return Buffer.from(out.buffer);
    }

    return {
      pushCalleeFrom8kPcm16(int16Array8k) {
        try {
          const buf48k = upsampleInt16Nearest(int16Array8k, 6); // 8k -> 48k
          calleeQueue = Buffer.concat([calleeQueue, buf48k]);
        } catch (e) {
          console.error('[LiveKit] pushCalleeFrom8kPcm16 error:', e);
        }
      },
      pushAgentFrom24kPcm16LEBuffer(pcm24kBuf) {
        try {
          // buf -> Int16Array length/2 samples
          const int16 = new Int16Array(pcm24kBuf.buffer, pcm24kBuf.byteOffset, Math.floor(pcm24kBuf.length / 2));
          const buf48k = upsampleInt16Nearest(int16, 2); // 24k -> 48k
          agentQueue = Buffer.concat([agentQueue, buf48k]);
        } catch (e) {
          console.error('[LiveKit] pushAgentFrom24k error:', e);
        }
      },
      pushAgentFrom48kInt16(int16Array48k) {
        try {
          const buf = Buffer.from(int16Array48k.buffer, int16Array48k.byteOffset, int16Array48k.length * 2);
          agentQueue = Buffer.concat([agentQueue, buf]);
        } catch (e) {
          console.error('[LiveKit] pushAgentFrom48kInt16 error:', e);
        }
      },
      async close() {
        try {
          if (calleeTimer) clearInterval(calleeTimer);
          if (agentTimer) clearInterval(agentTimer);
          await room.disconnect();
        } catch (e) {
          console.error('[LiveKit] close error:', e);
        }
      },
    };
  } catch (err) {
    console.error('[LiveKit] publisher init failed:', err);
    return null;
  }
}

module.exports = { createPublisher, toWsUrl };
