// Railway provides HTTPS. Express listens on Railway's internal HTTP port.
const { createApp } = require('./src/app');

if (require.main === module) {
  try {
    const app = createApp();
    const config = app.locals.config;
    if (!config.localDevelopment && !config.extensionSecret) {
      throw new Error('TWITCH_EXTENSION_SECRET is required');
    }
    const server = app.listen(config.port, config.host, () => {
      console.log(`Demon Bluff INZ server listening on ${config.host}:${server.address().port}`);
    });
    server.on('error', error => { console.error(error.code || 'Listen failed'); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
  } catch (error) {
    console.error(`Configuration error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createApp };
