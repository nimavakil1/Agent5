
require('dotenv').config();
const telnyx = require('telnyx')(process.env.TELNYX_API_KEY);
const { RoomServiceClient, AccessToken } = require('livekit-server-sdk');

const livekitHost = process.env.LIVEKIT_SERVER_URL;
const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
const roomService = new RoomServiceClient(livekitHost, apiKey, apiSecret);

/**
 * Creates an outbound call using Telnyx and a LiveKit room.
 * @param {string} to - The phone number to call.
 * @returns {Promise<object>} - An object containing the call and LiveKit room information.
 */
async function createOutboundCall(to) {
  try {
    // 1. Create a LiveKit Room
    const roomName = `call-${Date.now()}`;
    const room = await roomService.createRoom({ name: roomName });

    // 2. Create a Telnyx Call
    // TODO: Replace with your actual Telnyx Connection ID
    const connectionId = '2729194733782959144';
    const call = await telnyx.calls.create({
      to,
      from: process.env.TELNYX_PHONE_NUMBER,
      connection_id: connectionId,
      stream_url: `ws://51.195.41.57:3001/websocket?roomName=${roomName}`,
      stream_track: 'both_tracks',
    });

    // 3. Generate a LiveKit Token for the AI Agent
    const at = new AccessToken(apiKey, apiSecret, { identity: 'ai-agent' });
    at.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true });
    const token = at.toJwt();

    // 4. Return Information
    return { call, room, token };
  } catch (error) {
    console.error('Error creating outbound call:', error);
    throw error;
  }
}

module.exports = {
  createOutboundCall,
};
