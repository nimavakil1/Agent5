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
})();
