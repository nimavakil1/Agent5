module.exports = {
  apps: [
    {
      name: 'agent5-backend',
      cwd: './backend',
      script: 'src/index.js',
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production',
        TELNYX_CONNECTION_ID: '2786432608513296148',
        // Add your actual values for these environment variables:
        TELNYX_API_KEY: 'YOUR_TELNYX_API_KEY',
        TELNYX_PHONE_NUMBER: '+3225310001',
        // Telnyx should connect to this exact WS path
        TELNYX_STREAM_URL: 'wss://ai.acropaq.com/pstn-websocket',
        // LiveKit config split: WS for clients, HTTP(S) admin/Twirp for RoomService
        LIVEKIT_SERVER_URL: 'wss://ai.acropaq.com',
        LIVEKIT_API_URL: 'https://ai.acropaq.com',
        LIVEKIT_API_KEY: 'YOUR_LIVEKIT_API_KEY',
        LIVEKIT_API_SECRET: 'YOUR_LIVEKIT_API_SECRET',
        MONGO_URI: 'YOUR_MONGO_URI',
        AUTH_TOKEN: 'YOUR_AUTH_TOKEN',
        JWT_SECRET: 'YOUR_JWT_SECRET',
        OPENAI_API_KEY: 'YOUR_OPENAI_API_KEY',
        PORT: '3000'
      }
    }
  ]
};
