
require('dotenv').config();
const telnyx = require('telnyx')(process.env.TELNYX_API_KEY);
const { RoomServiceClient, AccessToken } = require('livekit-server-sdk');
const CallLogEntry = require('../../models/CallLogEntry');

const livekitHost = process.env.LIVEKIT_SERVER_URL;
const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
const roomService = new RoomServiceClient(livekitHost, apiKey, apiSecret);

/**
 * Creates an outbound call using Telnyx and a LiveKit room.
 * @param {string} to - The phone number to call.
 * @param {object} options - Optional parameters including campaign_id and customer_name.
 * @returns {Promise<object>} - An object containing the call and LiveKit room information.
 */
async function createOutboundCall(to, options = {}) {
  try {
    // 1. Allocate a pooled LiveKit Room (room1..roomN)
    const { allocate } = require('../../util/roomPool');
    const roomName = allocate();
    if (!roomName) throw new Error('No pooled rooms available');
    let room;
    try { room = await roomService.getRoom(roomName); } catch { room = await roomService.createRoom({ name: roomName }); }

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

    // 4. Create CallLogEntry
    const callLogEntry = new CallLogEntry({
      call_id: call.id,
      customer_id: options.customer_name || to,
      campaign_id: options.campaign_id || 'manual-dial',
      start_time: new Date(),
      end_time: null, // Will be updated when call ends
      language_detected: 'en', // Default, will be updated during call
      call_status: 'initiated',
      transcription: '',
      sentiment_scores: []
    });
    
    await callLogEntry.save();

    // 5. Return Information
    return { 
      call, 
      room, 
      token, 
      call_id: call.id,
      room_name: roomName,
      call_log_entry: callLogEntry 
    };
  } catch (error) {
    console.error('Error creating outbound call:', error);
    throw error;
  }
}

module.exports = {
  createOutboundCall,
};
