const { Readable } = require('stream');

async function streamTextToElevenlabs({ apiKey, voiceId, text, optimize = 4, abortSignal, onChunk }) {
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY missing');
  if (!voiceId) throw new Error('ELEVENLABS_VOICE_ID missing');
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?optimize_streaming_latency=${encodeURIComponent(String(optimize||4))}`;
  const body = {
    text: String(text||'').slice(0, 4000),
    model_id: 'eleven_monolingual_v1',
    output_format: 'pcm_24000',
    // voice_settings can be tuned later
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: abortSignal,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(()=> '');
    throw new Error(`ElevenLabs stream error ${resp.status} ${resp.statusText}: ${txt}`);
  }
  const reader = resp.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength && typeof onChunk === 'function') {
      try { await onChunk(Buffer.from(value)); } catch (_) {}
    }
  }
}

module.exports = { streamTextToElevenlabs };

