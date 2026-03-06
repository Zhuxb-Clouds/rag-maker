import cron from "node-cron";
import type { SyncContext } from "./sync.js";
import { syncSource, syncAll } from "./sync.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("pipeline:scheduler");

/** Active cron tasks for cleanup on shutdown. */
const cronTasks: cron.ScheduledTask[] = [];

/**
 * Start scheduled sync tasks for all configured sources.
 * Each source gets its own cron schedule.
 */
export function startScheduler(ctx: SyncContext): void {
  const sources = ctx.sourceManager.getAll();

  for (const source of sources) {
    if (!source.config.enabled) continue;

    const cronExpr = source.config.cron;

    if (!cron.validate(cronExpr)) {
      log.error({ source: source.config.id, cron: cronExpr }, "Invalid cron expression");
      continue;
    }

    const task = cron.schedule(cronExpr, async () => {
      log.info({ source: source.config.id }, "Scheduled sync triggered");
      try {
        await syncSource(source.config.id, ctx);
      } catch (error) {
        log.error({ error, source: source.config.id }, "Scheduled sync failed");
      }
    });

    cronTasks.push(task);
    log.info({ source: source.config.id, cron: cronExpr }, "Scheduled sync registered");
  }

  log.info({ tasks: cronTasks.length }, "Scheduler started");
}

/** Stop all scheduled tasks. */
export function stopScheduler(): void {
  for (const task of cronTasks) {
    task.stop();
  }
  cronTasks.length = 0;
  log.info("Scheduler stopped");
}

/**
 * Trigger an immediate sync for a source (e.g., from webhook).
 * Debouncing is handled inside syncSource.
 */
export async function triggerSync(sourceId: string | null, ctx: SyncContext): Promise<void> {
  if (sourceId) {
    await syncSource(sourceId, ctx);
  } else {
    await syncAll(ctx);
  }
}
