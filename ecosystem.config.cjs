module.exports = {
  apps: [
    {
      name: "battle-chess",
      script: "dist/index.cjs",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PORT: "3003",
      },
    },
  ],
};
