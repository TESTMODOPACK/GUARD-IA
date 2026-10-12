export const ALERTS_QUEUE = 'alerts' as const;
export const PROCESS_ALERT_JOB = 'process' as const;

export interface ProcessAlertJob {
  alertId: string;
  /** Marca de creación para medir latencia IA en métricas. */
  enqueuedAt: string;
}

export const PROCESS_ALERT_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};
