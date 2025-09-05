const WebSocket = require('ws');
const OpenAI = require('openai');
// use global fetch (Node >= 18)
const url = require('url'); // Import url module
const { RoomServiceClient, AccessToken } = require('livekit-server-sdk'); // Import LiveKit SDK
const CallLogEntry = require('../models/CallLogEntry'); // Import CallLogEntry model
const CustomerRecord = require('../models/CustomerRecord'); // Import CustomerRecord model
const fs = require('fs'); // Import file system module
const path = require('path'); // Import path module

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const OPENAI_REALTIME_SESSIONS_URL = 'https://api.openai.com/v1/realtime/sessions';

// LiveKit configuration
const livekitHost = process.env.LIVEKIT_SERVER_URL;
const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
const roomService = new RoomServiceClient(livekitHost, apiKey, apiSecret);

async function createOpenAISession(customerRecord = null) {
  try {
    let instructions = 'You are a helpful AI assistant for a call center.';
    if (customerRecord) {
      instructions += ` The customer's name is ${customerRecord.name}. Their preferred language is ${customerRecord.preferred_language || 'English'}. Their historical offers include: ${customerRecord.historical_offers.join(', ')}.`;
    }

    const response = await fetch(OPENAI_REALTIME_SESSIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview', // Or 'gpt-realtime'
        modalities: ['audio', 'text'],
        instructions: instructions,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Failed to create OpenAI session: ${response.status} ${response.statusText} - ${errorData.message}`);
    }

    const sessionData = await response.json();
    console.log('OpenAI session created:', sessionData);
    return sessionData;
  } catch (error) {
    console.error('Error creating OpenAI session:', error);
    throw error;
  }
}

function createWebSocketServer(server) {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', async (telnyxWs, req) => { // Add req parameter
    console.log('Telnyx WebSocket client connected');

    const parsedUrl = url.parse(req.url, true);
    const rawRoom = parsedUrl.query.roomName;
    const roomName = String(rawRoom || '').replace(/[^a-zA-Z0-9_-]/g, '');

    if (!roomName) {
      console.error('Room name not provided in WebSocket URL');
      telnyxWs.close();
      return;
    }

    console.log(`Telnyx connected for LiveKit room: ${roomName}`);

    let openaiWs = null; // WebSocket connection to OpenAI
    let livekitRoom = null; // LiveKit Room object
    let telnyxParticipant = null; // LiveKit Participant for Telnyx audio
    let customerRecord = null; // Customer Record for personalization
    let currentTranscription = ''; // To accumulate transcription
    let audioChunks = []; // To accumulate audio for recording

    // Ensure a call log document exists with required fields
    async function ensureCallLogDefaults() {
      const now = new Date();
      await CallLogEntry.findOneAndUpdate(
        { call_id: roomName },
        {
          $setOnInsert: {
            call_id: roomName,
            customer_id: 'unknown',
            campaign_id: 'unknown',
            start_time: now,
            end_time: now,
            language_detected: 'und',
            call_status: 'no_answer',
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    try {
      // Fetch customer record based on roomName (assuming it maps to a call_id/phone_number)
      const callLog = await CallLogEntry.findOne({ call_id: roomName });
      if (callLog && callLog.customer_id) {
        customerRecord = await CustomerRecord.findOne({ customer_id: callLog.customer_id });
        console.log('Fetched Customer Record:', customerRecord ? customerRecord.name : 'Not found');
      } else if (callLog && callLog.phone_number) {
        customerRecord = await CustomerRecord.findOne({ phone_number: callLog.phone_number });
        console.log('Fetched Customer Record:', customerRecord ? customerRecord.name : 'Not found');
      }

      // 1. Join LiveKit room with Telnyx participant
      const telnyxParticipantIdentity = `telnyx-bot-${roomName}`;
      const telnyxParticipantAccessToken = new AccessToken(apiKey, apiSecret, {
        identity: telnyxParticipantIdentity,
      });
      telnyxParticipantAccessToken.addGrant({
        room: roomName,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
      });
      const telnyxParticipantToken = telnyxParticipantAccessToken.toJwt();

      // This part is tricky: LiveKit SDK is for server-side room management, not joining as a client.
      // To join as a client, we'd typically use livekit-client SDK in a browser or a separate process.
      // For a server-side bot, we'd use livekit-server-sdk to manage tracks.
      // For now, we'll just ensure the room exists and log.
      // Actual publishing will require a LiveKit client.
      try {
        livekitRoom = await roomService.getRoom(roomName);
        console.log(`LiveKit room ${roomName} exists.`);
      } catch (e) {
        console.log(`LiveKit room ${roomName} does not exist, creating...`);
        livekitRoom = await roomService.createRoom({ name: roomName });
        console.log(`LiveKit room ${roomName} created.`);
      }

      // Conceptual: AI Agent joins LiveKit room
      const aiAgentIdentity = `ai-agent-${roomName}`;
      const aiAgentAccessToken = new AccessToken(apiKey, apiSecret, {
        identity: aiAgentIdentity,
      });
      aiAgentAccessToken.addGrant({
        room: roomName,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
      });
      const aiAgentToken = aiAgentAccessToken.toJwt();
      console.log(`Conceptual: AI Agent ${aiAgentIdentity} joins LiveKit room ${roomName} with token: ${aiAgentToken}`);


      // 2. Create OpenAI Session and connect WebSocket
      const session = await createOpenAISession(customerRecord);
      const OPENAI_REALTIME_API_URL = session.websocket_url;

      openaiWs = new WebSocket(OPENAI_REALTIME_API_URL);

      openaiWs.onopen = () => {
        console.log('Connected to OpenAI Realtime API');
        // Send initial message to OpenAI
        openaiWs.send(JSON.stringify({
          type: 'conversation.item.create',
          content: {
            type: 'input_text',
            text: 'Hello, how can I help you today?',
          },
          modalities: ['audio', 'text'],
        }));
      };

      openaiWs.onmessage = async (message) => {
        try {
          const openaiResponse = JSON.parse(message.data);
          console.log('Received from OpenAI:', openaiResponse);

          // Assuming OpenAI Realtime API provides text in some part of the response
          if (openaiResponse.type === 'conversation.item.update' && openaiResponse.content && openaiResponse.content.type === 'text_output') {
            const textContent = openaiResponse.content.text;
            console.log('OpenAI Text Output:', textContent);

            currentTranscription += textContent + ' '; // Append to transcription

            await ensureCallLogDefaults();
            // Update CallLogEntry with transcription
            await CallLogEntry.findOneAndUpdate(
              { call_id: roomName },
              { transcription: currentTranscription },
              { new: true, runValidators: true }
            );

            // TODO: Language Detection and Switching
            const detectedLanguage = 'en'; // Placeholder: Replace with actual detected language
            console.log('Conceptual: Detected Language:', detectedLanguage);

            // Store detected language in CallLogEntry
            await CallLogEntry.findOneAndUpdate(
              { call_id: roomName },
              { language_detected: detectedLanguage },
              { new: true, runValidators: true }
            );

            // TODO: Perform sentiment analysis on textContent
            const sentiment = {
              timestamp: new Date(),
              sentiment: 'neutral', // Placeholder
              score: 0.5, // Placeholder
            };
            console.log('Sentiment Analysis Result:', sentiment);

            // Store sentiment in CallLogEntry
            // This assumes a CallLogEntry already exists for this roomName/call_id
            // In a real scenario, the CallLogEntry would be created when the call starts
            // and updated throughout the call.
            await CallLogEntry.findOneAndUpdate(
              { call_id: roomName }, // Use roomName as call_id
              { $push: { sentiment_scores: sentiment } },
              { new: true, runValidators: true }
            );
          }

          // Conceptual: Publish OpenAI audio to LiveKit room via AI Agent
          // This would involve using LiveKit client SDK or a server-side bot framework
          // For now, we'll just log that audio is received.
          if (openaiResponse.type === 'conversation.item.update' && openaiResponse.content && openaiResponse.content.type === 'audio_output') {
            const audioBase64 = openaiResponse.content.audio;
            console.log('Conceptual: AI Agent publishing audio to LiveKit (base64):', audioBase64.substring(0, 50) + '...');
            // TODO: Transcode OpenAI audio to Telnyx PCMU 8kHz
            // TODO: Encode OpenAI audio and send to Telnyx
            // telnyxWs.send(encodedOpenAIAudio);
          }

        } catch (error) {
          console.error('Error processing OpenAI message:', error);
        }
      };

      openaiWs.onclose = () => {
        console.log('Disconnected from OpenAI Realtime API');
      };

      openaiWs.onerror = (error) => {
        console.error('OpenAI WebSocket error:', error);
      };

    } catch (error) {
      console.error('Failed to establish LiveKit/OpenAI connection:', error);
      telnyxWs.close(); // Close Telnyx connection if OpenAI fails
      return;
    }

    telnyxWs.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        if (data.event === 'start') {
          console.log('Telnyx stream started:', data);
          audioChunks = []; // Reset for new call
          await ensureCallLogDefaults();
        } else if (data.event === 'media') {
          const audioBase64 = data.media.payload;
          const audioBuffer = Buffer.from(audioBase64, 'base64');
          audioChunks.push(audioBuffer); // Accumulate audio

          // TODO: Transcode audio from Telnyx PCMU 8kHz to OpenAI 16-bit PCM 24kHz mono
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(audioBuffer);
          }

          // TODO: Publish audio to LiveKit room via telnyxParticipant
          // This would involve using LiveKit client SDK or a server-side bot framework
        } else if (data.event === 'stop') {
          console.log('Telnyx stream stopped:', data);
          if (openaiWs) {
            openaiWs.close();
          }
          // TODO: Disconnect telnyxParticipant from LiveKit
        }
      } catch (error) {
        console.error('Error parsing Telnyx WebSocket message:', error);
      }
    });

    telnyxWs.on('close', async () => { // Make async for DB operations
      console.log('Telnyx WebSocket client disconnected');
      if (openaiWs) {
        openaiWs.close();
      }

      // Save audio recording
      if (audioChunks.length > 0) {
        const audioFileName = `${roomName}.wav`;
        const recordingsDir = path.resolve(__dirname, '../../recordings');
        const audioFilePath = path.resolve(recordingsDir, audioFileName); // Save in a 'recordings' folder
        const audioRecordingUrl = `/recordings/${audioFileName}`; // URL for access

        // Ensure recordings directory exists
        if (!fs.existsSync(recordingsDir)) {
          fs.mkdirSync(recordingsDir);
        }

        // Concatenate all audio chunks
        const fullAudioBuffer = Buffer.concat(audioChunks);

        // For PCMU, we need to add a WAV header. This is a simplified example.
        // A proper WAV header for 8kHz, mono, 8-bit PCMU (G.711 U-law)
        const sampleRate = 8000; // Telnyx PCMU is 8kHz
        const numChannels = 1;
        const bitsPerSample = 8; // PCMU is 8-bit
        const byteRate = sampleRate * numChannels * bitsPerSample / 8;
        const blockAlign = numChannels * bitsPerSample / 8;
        const dataSize = fullAudioBuffer.length;
        const fileSize = dataSize + 36; // 36 bytes for WAV header (excluding data chunk header)

        const wavHeader = Buffer.alloc(44);
        wavHeader.write('RIFF', 0);
        wavHeader.writeUInt32LE(fileSize, 4);
        wavHeader.write('WAVE', 8);
        wavHeader.write('fmt ', 12);
        wavHeader.writeUInt32LE(16, 16); // Subchunk1Size for PCM
        wavHeader.writeUInt16LE(7, 20); // AudioFormat: 7 for G.711 U-law (PCMU)
        wavHeader.writeUInt16LE(numChannels, 22);
        wavHeader.writeUInt32LE(sampleRate, 24);
        wavHeader.writeUInt32LE(byteRate, 28);
        wavHeader.writeUInt16LE(blockAlign, 32);
        wavHeader.writeUInt16LE(bitsPerSample, 34);
        wavHeader.write('data', 36);
        wavHeader.writeUInt32LE(dataSize, 40);

        const finalAudioBuffer = Buffer.concat([wavHeader, fullAudioBuffer]);

        fs.writeFileSync(audioFilePath, finalAudioBuffer);
        console.log(`Audio recording saved to: ${audioFilePath}`);

        // Update CallLogEntry with audio recording URL
        await ensureCallLogDefaults();
        await CallLogEntry.findOneAndUpdate(
          { call_id: roomName },
          { audio_recording_url: audioRecordingUrl },
          { new: true, runValidators: true }
        );
      }
      // TODO: Disconnect telnyxParticipant from LiveKit
    });

    telnyxWs.on('error', (error) => {
      console.error('Telnyx WebSocket error:', error);
      if (openaiWs) {
        openaiWs.close();
      }
      // TODO: Disconnect telnyxParticipant from LiveKit
    });
  });

  return wss;
}

module.exports = { createWebSocketServer };
