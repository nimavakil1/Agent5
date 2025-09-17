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
        TELNYX_STREAM_URL: 'https://agent.acropaq.com',
        LIVEKIT_SERVER_URL: 'YOUR_LIVEKIT_SERVER_URL',
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

