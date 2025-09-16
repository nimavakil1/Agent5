const { Readable } = require('stream');

async function streamTextToElevenlabs({ apiKey, voiceId, text, optimize = 4, abortSignal, onChunk, debug = false }) {
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY missing');
  if (!voiceId) throw new Error('ELEVENLABS_VOICE_ID missing');
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?optimize_streaming_latency=${encodeURIComponent(String(optimize||4))}`;
  const body = {
    text: String(text||'').slice(0, 4000),
    model_id: 'eleven_monolingual_v1',
    output_format: 'pcm_24000',
    // voice_settings can be tuned later
  };
  if (debug) console.log(`[11labs] start stream: voice=${voiceId} len=${(text||'').length} opt=${optimize}`);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'content-type': 'application/json',
      'accept': 'application/octet-stream'
    },
    body: JSON.stringify(body),
    signal: abortSignal,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(()=> '');
    throw new Error(`ElevenLabs stream error ${resp.status} ${resp.statusText}: ${txt}`);
  }
  const reader = resp.body.getReader();
  let total = 0; let chunks = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength && typeof onChunk === 'function') {
      try { await onChunk(Buffer.from(value)); } catch (_) {}
      total += value.byteLength; chunks++;
      if (debug && chunks <= 3) console.log(`[11labs] chunk ${chunks} size=${value.byteLength}`);
    }
  }
  if (debug) console.log(`[11labs] end stream: chunks=${chunks} total=${total}`);
}

module.exports = { streamTextToElevenlabs };
