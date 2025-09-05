
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
    const connectionId = process.env.TELNYX_CONNECTION_ID;
    if (!connectionId) {
      throw new Error('TELNYX_CONNECTION_ID not configured');
    }

    // Streaming URL for Telnyx to connect back to this server
    const baseStreamUrl = (process.env.TELNYX_STREAM_URL || '').replace(/\/$/, '');
    const localPort = process.env.PORT || 3000;
    const defaultStreamUrl = `ws://localhost:${localPort}/websocket`;
    const streamBase = baseStreamUrl || defaultStreamUrl; // Prefer env, default to local dev

    const call = await telnyx.calls.create({
      to,
      from: process.env.TELNYX_PHONE_NUMBER,
      connection_id: connectionId,
      // Provide roomName as a query param for the WS server
      stream_url: `${streamBase}?roomName=${encodeURIComponent(roomName)}`,
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
