// pm2 process file (SPEC.md section 16.11). Start with: pm2 start ecosystem.config.cjs
//
// shutdown_with_message: on Windows `pm2 stop` delivers no SIGINT/SIGTERM, so
// pm2 sends process.send('shutdown') instead; the bot handles it like Ctrl+C:
// stop new entries and sells, wait for in-flight transactions (bounded by
// blockhash expiry, at most 120 s), persist state, exit.
//
// kill_timeout: 150 s, above the bot's 120 s shutdown bound, so pm2 never
// kills it while it's still waiting for a transaction to confirm or expire.
module.exports = {
  apps: [
    {
      name: "trader",
      script: "src/index.ts",
      interpreter: "node",
      node_args: "--import tsx/esm",
      cwd: __dirname,
      shutdown_with_message: true,
      kill_timeout: 150000,
      autorestart: true,
    },
  ],
};
