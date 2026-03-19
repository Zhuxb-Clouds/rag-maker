import pino from "pino";

const logDestination = pino.destination({
  dest: 2,
  sync: process.env.NODE_ENV === "test",
});

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  logDestination,
);

export function createChildLogger(name: string) {
  return logger.child({ module: name });
}
