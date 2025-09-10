module.exports = {
  apps: [
    {
      name: 'agent5-backend',
      cwd: './backend',
      script: 'src/index.js',
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};

