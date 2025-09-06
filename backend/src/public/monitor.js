(() => {
  const logEl = document.getElementById('logs');
  function log(...args) {
    const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    logEl.textContent += msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }

  let room = null;
  const tracksEl = document.getElementById('tracks');

  async function join() {
    try {
      const host = document.getElementById('host').value.trim();
      const roomName = document.getElementById('room').value.trim();
      let identity = document.getElementById('identity').value.trim();
      if (!host || !roomName) return alert('host and room are required');
      if (!identity) identity = 'viewer-' + Date.now();

      // fetch token from backend
      const tokenInput = document.getElementById('token').value.trim();
      if (tokenInput) {
        localStorage.setItem('AUTH_TOKEN', tokenInput);
      }
      const bearer = localStorage.getItem('AUTH_TOKEN') || '';
      const res = await fetch(
        `/api/livekit/token?room=${encodeURIComponent(roomName)}&identity=${encodeURIComponent(identity)}`,
        {
          headers: { Authorization: `Bearer ${bearer}` },
        }
      );
      if (!res.ok) {
        log('Failed to get token', await res.text());
        return;
      }
      const { token } = await res.json();

      const LK =
        window.LivekitClient ||
        window.LiveKitClient ||
        window.LiveKit ||
        window.livekitClient ||
        window.livekit || null;
      if (!LK) {
        log('LiveKit client not loaded. Make sure the CDN script is reachable.');
        return;
      }
      room = new LK.Room();
      await room.connect(host, token);
      log('Connected to room');

      room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, pub) => {
        log('TrackSubscribed', pub.trackName || pub.source || 'audio');
        if (track.kind === 'audio') {
          const audio = document.createElement('audio');
          audio.autoplay = true;
          audio.controls = true;
          track.attach(audio);
          audio.dataset.name = pub.trackName || 'audio';
          tracksEl.appendChild(audio);
        }
      });

      room.on(LivekitClient.RoomEvent.Disconnected, () => log('Disconnected'));
    } catch (e) {
      log('Error:', e.message || String(e));
    }
  }

  async function leave() {
    try {
      if (room) {
        await room.disconnect();
        room = null;
        tracksEl.innerHTML = '';
      }
    } catch (e) {
      log('Error leaving:', e.message || String(e));
    }
  }

  document.getElementById('join').onclick = join;
  document.getElementById('leave').onclick = leave;
  document.getElementById('saveToken').onclick = () => {
    const v = document.getElementById('token').value.trim();
    if (v) {
      localStorage.setItem('AUTH_TOKEN', v);
      log('Token saved');
    } else {
      log('Enter a token before saving');
    }
  };

  // Mic streaming to backend WS -> OpenAI
  let micStream = null;
  let audioCtx = null;
  let procNode = null;
  let ws = null;
  let lastCommitAt = 0;
  let latencyEl = null;

  function floatTo16BitPCM(input) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      let s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function downsample48kTo24k(int16) {
    const out = new Int16Array(Math.floor(int16.length / 2));
    for (let i = 0, j = 0; j < out.length; i += 2, j++) out[j] = int16[i];
    return out;
  }

  async function startTalk() {
    try {
      const roomName = document.getElementById('room').value.trim();
      if (!roomName) return alert('room required');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/agent-stream?room=${encodeURIComponent(roomName)}`);
      ws.onopen = () => log('Talk WS connected');
      ws.onclose = () => log('Talk WS closed');
      ws.onerror = (e) => log('Talk WS error');
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'first_audio_delta' && lastCommitAt) {
            const dt = Date.now() - lastCommitAt;
            if (!latencyEl) latencyEl = document.getElementById('latency');
            if (latencyEl) latencyEl.textContent = `${dt} ms`;
            log('Latency:', dt + ' ms');
          }
        } catch(_) {}
      };

      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      const src = audioCtx.createMediaStreamSource(micStream);
      const bufSize = 1024;
      procNode = audioCtx.createScriptProcessor(bufSize, 1, 1);
      procNode.onaudioprocess = (e) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        const int16 = floatTo16BitPCM(input);
        const ds = downsample48kTo24k(int16);
        // Convert to base64 LE bytes
        const buf = new Uint8Array(ds.length * 2);
        for (let i = 0; i < ds.length; i++) {
          buf[i * 2] = ds[i] & 0xff;
          buf[i * 2 + 1] = (ds[i] >> 8) & 0xff;
        }
        const b64 = btoa(String.fromCharCode(...buf));
        ws.send(JSON.stringify({ type: 'audio', audio: b64 }));
      };
      src.connect(procNode);
      procNode.connect(audioCtx.destination);
      log('Mic streaming started');
    } catch (e) {
      log('startTalk error:', e.message || String(e));
    }
  }

  async function stopTalk() {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        lastCommitAt = Date.now();
        ws.send(JSON.stringify({ type: 'commit' }));
      }
      if (procNode) { try { procNode.disconnect(); } catch(_) {} procNode = null; }
      if (audioCtx) { try { audioCtx.close(); } catch(_) {} audioCtx = null; }
      if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
      log('Mic streaming stopped');
    } catch (e) {
      log('stopTalk error:', e.message || String(e));
    }
  }

  document.getElementById('talk').onclick = startTalk;
  document.getElementById('stopTalk').onclick = stopTalk;
  // Create latency label
  (function(){
    const row = document.createElement('div'); row.className='row';
    const lbl = document.createElement('strong'); lbl.textContent='Latency:'; row.appendChild(lbl);
    const span = document.createElement('span'); span.id='latency'; span.style.marginLeft='8px'; span.textContent='--'; row.appendChild(span);
    document.body.insertBefore(row, document.getElementById('logs').parentElement);
  })();
})();
