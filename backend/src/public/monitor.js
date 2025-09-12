(() => {
  const logEl = document.getElementById('logs');
  function log(...args) {
    const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    logEl.textContent += msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }

  let room = null;
  const tracksEl = document.getElementById('tracks');
  const roomsEl = document.getElementById('rooms');

  async function join(roomNameParam) {
    try {
      const roomName = String(roomNameParam || '').trim();
      let identity = 'viewer-' + Date.now();
      if (!roomName) return alert('room is required');

      // fetch token from backend
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
      const { token, host: srvHost } = await res.json();

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
      const url = (srvHost && (srvHost.startsWith('ws') ? srvHost : (srvHost.startsWith('http') ? (srvHost.replace(/^http/,'ws')) : srvHost))) || host;
      await room.connect(url, token);
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

  // Leave handled globally via room.disconnect

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
      const primeText = (document.getElementById('primeText')?.value || '').trim();
      if (!roomName) return alert('room required');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const qs = new URLSearchParams({ room: roomName });
      if (primeText) qs.set('text', primeText);
      ws = new WebSocket(`${proto}://${location.host}/agent-stream?${qs.toString()}`);
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

  // Removed talk/stopTalk; use Take Over button per-room instead
  // Create latency label
  (function(){
    const row = document.createElement('div'); row.className='row';
    const lbl = document.createElement('strong'); lbl.textContent='Latency:'; row.appendChild(lbl);
    const span = document.createElement('span'); span.id='latency'; span.style.marginLeft='8px'; span.textContent='--'; row.appendChild(span);
    document.body.insertBefore(row, document.getElementById('logs').parentElement);
  })();

  // --- Active Rooms UI ---
  async function loadRooms() {
    try {
      const bearer = localStorage.getItem('AUTH_TOKEN') || '';
      let r = await fetch('/api/livekit/rooms', { headers: { Authorization: `Bearer ${bearer}` } });
      let rooms = [];
      if (r.ok) {
        rooms = await r.json();
        if (!Array.isArray(rooms) || rooms.length === 0) {
          const r2 = await fetch('/api/livekit/recent-rooms', { headers: { Authorization: `Bearer ${bearer}` } });
          if (r2.ok) rooms = await r2.json();
        }
      } else {
        const r2 = await fetch('/api/livekit/recent-rooms', { headers: { Authorization: `Bearer ${bearer}` } });
        if (r2.ok) rooms = await r2.json();
      }
      renderRooms(Array.isArray(rooms) ? rooms : []);
    } catch (e) {
      console.error('loadRooms error', e);
    }
  }

  function renderRooms(list) {
    roomsEl.innerHTML = '';
    // prefer rooms with participants > 0 if available
    const populated = list.filter((x)=> (x.num_participants||0) > 0);
    const show = populated.length ? populated : list;
    if (!show.length) {
      const div = document.createElement('div'); div.className='muted text-sm'; div.textContent='No active rooms'; roomsEl.appendChild(div); return;
    }
    show.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between gap-2 p-2 border border-[#283039] rounded';
      const left = document.createElement('div');
      left.innerHTML = `<div class="font-medium">${r.name}</div><div class="text-xs muted">participants: ${r.num_participants ?? '?'} </div>`;
      const right = document.createElement('div'); right.className='flex items-center gap-2';
      const joinBtn = document.createElement('button'); joinBtn.className='btn btn-primary'; joinBtn.textContent='Join';
      joinBtn.onclick = () => { join(r.name); };
      const stopBtn = document.createElement('button'); stopBtn.className='btn btn-danger'; stopBtn.textContent='Stop AI';
      stopBtn.onclick = async () => {
        const bearer = localStorage.getItem('AUTH_TOKEN') || '';
        const res = await fetch(`/api/livekit/rooms/${encodeURIComponent(r.name)}/stop_ai`, { method:'POST', headers:{ Authorization: `Bearer ${bearer}`, 'Content-Type':'application/json' } });
        if (!res.ok) { alert('Failed to stop AI'); }
      };
      const takeBtn = document.createElement('button'); takeBtn.className='btn'; takeBtn.style.background='#10b981'; takeBtn.style.color='#fff'; takeBtn.textContent='Take Over';
      takeBtn.onclick = () => startOperatorBridge(r.name);
      right.appendChild(joinBtn); right.appendChild(stopBtn); right.appendChild(takeBtn);
      row.appendChild(left); row.appendChild(right);
      roomsEl.appendChild(row);
    });
  }

  // Operator takeover: stream mic to server bridge -> PSTN
  let opWs = null; let opAudio = { stream:null, ctx:null, proc:null };
  async function startOperatorBridge(roomName) {
    try {
      if (!roomName) return alert('room required');
      if (opWs && opWs.readyState === WebSocket.OPEN) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      opWs = new WebSocket(`${proto}://${location.host}/operator-bridge?room=${encodeURIComponent(roomName)}`);
      opWs.onopen = () => log('Operator bridge connected');
      opWs.onclose = () => log('Operator bridge closed');
      opWs.onerror = () => log('Operator bridge error');
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      const src = ctx.createMediaStreamSource(micStream);
      const proc = ctx.createScriptProcessor(1024, 1, 1);
      proc.onaudioprocess = (e) => {
        if (!opWs || opWs.readyState !== WebSocket.OPEN) return;
        const f32 = e.inputBuffer.getChannelData(0);
        const i16 = floatTo16BitPCM(f32);
        // Downsample 48k -> 24k by dropping every other sample
        const out = new Int16Array(Math.floor(i16.length/2));
        for (let i=0,j=0;j<out.length;i+=2,j++) out[j] = i16[i];
        const buf = new Uint8Array(out.length*2);
        for (let i=0;i<out.length;i++){ buf[i*2]=out[i]&0xff; buf[i*2+1]=(out[i]>>8)&0xff; }
        const b64 = btoa(String.fromCharCode(...buf));
        opWs.send(JSON.stringify({ type:'audio', audio:b64 }));
      };
      src.connect(proc); proc.connect(ctx.destination);
      opAudio = { stream: micStream, ctx, proc };
    } catch (e) { log('Operator bridge error:', e.message||String(e)); }
  }

  function stopOperatorBridge() {
    try { if (opWs && opWs.readyState === WebSocket.OPEN) opWs.close(); } catch(_) {}
    opWs = null;
    try { if (opAudio.proc) opAudio.proc.disconnect(); } catch(_) {}
    try { if (opAudio.ctx) opAudio.ctx.close(); } catch(_) {}
    try { if (opAudio.stream) opAudio.stream.getTracks().forEach(t=>t.stop()); } catch(_) {}
    opAudio = { stream:null, ctx:null, proc:null };
  }

  // Poll rooms
  setInterval(loadRooms, 5000);
  loadRooms();
})();
