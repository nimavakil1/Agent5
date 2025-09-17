
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
    // Allocate from shared pool with Mongo-backed lock to avoid double-booking
    const { allocate } = require('../../util/mongoAllocator');
    const roomName = await allocate({ owner: 'pstn-outbound' });
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
    
    // Use clean PSTN WebSocket handler
    const defaultStreamUrl = `ws://localhost:${localPort}/pstn-websocket`;
    const streamBase = baseStreamUrl ? `${baseStreamUrl}/pstn-websocket` : defaultStreamUrl;

    // Attach context for routing (campaign/lang) to the Telnyx stream URL so the WS layer can resolve
    const params = new URLSearchParams({ roomName });
    if (options.campaign_id) params.set('campaign', String(options.campaign_id));
    if (options.language) params.set('lang', String(options.language));
    const streamUrl = `${streamBase}?${params.toString()}`;

    const callParams = {
      to,
      from: process.env.TELNYX_PHONE_NUMBER,
      connection_id: connectionId,
      // Provide roomName (+ optional campaign/lang) as query params for the WS server
      stream_url: streamUrl,
      // stream_track: 'both_tracks', // Removed for FQDN connections
    };
    
    console.log('Creating Telnyx call with params:', JSON.stringify(callParams, null, 2));
    
    let call;
    try {
      call = await telnyx.calls.create(callParams);
    } catch (telnyxError) {
      console.error('Telnyx API Error Details:', {
        message: telnyxError.message,
        statusCode: telnyxError.statusCode,
        responseBody: telnyxError.responseBody,
        response: telnyxError.response?.data || telnyxError.response,
        data: telnyxError.data,
        errors: telnyxError.errors,
        body: telnyxError.body,
        rawResponse: telnyxError.rawResponse,
        fullError: JSON.stringify(telnyxError, Object.getOwnPropertyNames(telnyxError), 2)
      });
      
      // Try to extract more detailed error info
      let errorDetail = 'Unknown error';
      if (telnyxError.response?.data?.errors) {
        errorDetail = JSON.stringify(telnyxError.response.data.errors);
      } else if (telnyxError.errors) {
        errorDetail = JSON.stringify(telnyxError.errors);
      } else if (telnyxError.responseBody) {
        errorDetail = telnyxError.responseBody;
      } else if (telnyxError.message) {
        errorDetail = telnyxError.message;
      }
      
      throw new Error(`Telnyx API Error: ${errorDetail} (Status: ${telnyxError.statusCode})`);
    }

    // 3. Generate a LiveKit Token for the AI Agent
    const at = new AccessToken(apiKey, apiSecret, { identity: 'ai-agent' });
    at.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true });
    const token = at.toJwt();

    // 4. Create CallLogEntry
    const callLogEntry = new CallLogEntry({
      call_id: roomName,
      telnyx_call_id: call.id,
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
      call_id: roomName,
      telnyx_call_id: call.id,
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
