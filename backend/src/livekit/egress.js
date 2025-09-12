const { EgressClient, EncodedFileOutput, AudioCodec, FileType } = require('livekit-server-sdk');

function makeEgressClient() {
  const host = process.env.LIVEKIT_API_URL || process.env.LIVEKIT_SERVER_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!host || !apiKey || !apiSecret) return null;
  try { return new EgressClient(host, apiKey, apiSecret); } catch (_) { return null; }
}

function filenameFor(roomName) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${roomName}-${ts}`;
  const ext = process.env.LIVEKIT_EGRESS_FILE_EXT || 'mp4';
  const prefix = process.env.LIVEKIT_EGRESS_PREFIX || 'egress';
  return `${prefix}/${base}.${ext}`;
}

async function startRoomAudioEgress(roomName) {
  const client = makeEgressClient();
  if (!client) throw new Error('EgressClient not configured');
  // Newer SDKs expose options as plain objects (not constructors)
  const options = { audioOnly: true, audioCodec: AudioCodec.OPUS };
  const output = new EncodedFileOutput({
    fileType: (process.env.LIVEKIT_EGRESS_FILE_EXT || 'mp4').toLowerCase() === 'ogg' ? FileType.OGG : FileType.MP4,
    filepath: filenameFor(roomName),
  });
  const info = await client.startRoomCompositeEgress(roomName, options, output);
  return info; // contains egressId
}

async function stopEgress(egressId) {
  const client = makeEgressClient();
  if (!client) throw new Error('EgressClient not configured');
  return client.stopEgress(egressId);
}

module.exports = { startRoomAudioEgress, stopEgress };
