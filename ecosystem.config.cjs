module.exports = {
  apps: [
    {
      name: 'animem-s3-bot',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      node_args: '--expose-gc --max-old-space-size=512',
      max_memory_restart: '550M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};
