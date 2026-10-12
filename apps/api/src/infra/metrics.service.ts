import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

/** Métricas Prometheus mínimas: lo que importa es la latencia del paso 2 y de la IA. */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  /** Desde que llega POST /alerts hasta que se emite alert.created. */
  readonly alertCreateLatency = new Histogram({
    name: 'guardia_alert_create_seconds',
    help: 'Latencia de POST /alerts hasta emitir alert.created',
    labelNames: ['type'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [this.registry],
  });

  readonly aiProcessing = new Histogram({
    name: 'guardia_ai_processing_seconds',
    help: 'Duración del job de IA por proveedor y resultado',
    labelNames: ['provider', 'outcome'] as const,
    buckets: [0.5, 1, 2, 5, 10, 20, 40],
    registers: [this.registry],
  });

  readonly alertsCreated = new Counter({
    name: 'guardia_alerts_created_total',
    help: 'Alertas creadas por tipo y estado inicial',
    labelNames: ['type', 'status'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  render() {
    return this.registry.metrics();
  }
}
