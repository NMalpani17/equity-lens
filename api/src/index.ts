/** Server entrypoint. */
import { createApp } from "./app.js";
import { config } from "./config.js";
import { prisma } from "./db/prisma.js";
import { logger } from "./logger.js";
import { registerShutdown } from "./shutdown.js";

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.nodeEnv }, "equity-lens-api listening");
});

// Cloud Run sends SIGTERM ~10s before killing the instance.
registerShutdown(server, { onClose: () => prisma.$disconnect() });
