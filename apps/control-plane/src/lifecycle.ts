import type { FastifyInstance } from 'fastify';

interface TaskLifecycle {
  tick(): Promise<void>;
  stop(): Promise<void>;
  scrubExpiredContexts(): void;
}
interface InteractionLifecycle {
  purgeExpired(): void;
  shutdown(): Promise<void>;
}
/** The process owns scheduling and shutdown; application services own the work. */
export function registerLifecycle(server: FastifyInstance, tasks: TaskLifecycle, interaction: InteractionLifecycle, closeStore: () => void, pollIntervalMs = 1000, maintenance?:{tick():Promise<void>;stop():Promise<void>}): void {
  tasks.scrubExpiredContexts();
  interaction.purgeExpired();
  const polling = pollIntervalMs === 0 ? undefined : setInterval(() => {
    void maintenance?.tick().catch(()=>{ /* Durable maintenance jobs reconcile on the next wake. */ });
    void tasks.tick().catch(() => { /* Durable outbox remains available for reconciliation. */ });
  }, pollIntervalMs);
  polling?.unref();
  const retention = setInterval(() => interaction.purgeExpired(), 60_000);
  retention.unref();
  server.addHook('preClose', async () => {
    if (polling) clearInterval(polling);
    clearInterval(retention);
    const maintenanceStopped=maintenance?.stop();
    // Abort adapter work before awaiting a maintenance model request during shutdown.
    await interaction.shutdown();
    await maintenanceStopped;
    await tasks.stop();
  });
  server.addHook('onClose', async () => {
    try { await interaction.shutdown(); }
    finally { closeStore(); }
  });
}
