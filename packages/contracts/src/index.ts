/** Health/readiness wire version. Runtime DTOs below do not define HTTP routes or wire schemas. */
export const PROTOCOL_VERSION = '0.1.0' as const;
export type ServiceName = 'control-plane' | 'platform' | 'interaction-task' | 'runtime-host-pi';

export interface HealthResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  service: ServiceName;
  status: 'alive';
  /** Configured authenticated dispatch handler, not verified provider connectivity. */
  executionAvailable: boolean;
}

/** Trusted, portable JSON Schema; never compile schemas supplied by clients. */
export const healthResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['protocolVersion', 'service', 'status', 'executionAvailable'],
  properties: {
    protocolVersion: { type: 'string', const: PROTOCOL_VERSION },
    service: { type: 'string', enum: ['control-plane', 'platform', 'interaction-task', 'runtime-host-pi'] },
    status: { type: 'string', const: 'alive' },
    executionAvailable: { type: 'boolean' },
  },
} as const;

export type ReadinessResponse = {
  protocolVersion: typeof PROTOCOL_VERSION;
  service: ServiceName;
} & (
  | { status: 'not_ready'; reason: 'foundation_only' | 'pi_not_integrated' | 'runtime_not_verified' | 'runtime_not_configured' | 'configuration_unavailable' }
  | { status: 'ready'; providerConnectivity: 'unverified' }
);

/** Ready means the local authenticated transport is configured, not a provider smoke test. */
export const readinessResponseSchema = {
  anyOf: [
    { type: 'object', additionalProperties: false,
      required: ['protocolVersion', 'service', 'status', 'reason'],
      properties: {
        protocolVersion: { type: 'string', const: PROTOCOL_VERSION },
        service: { type: 'string', enum: ['control-plane', 'platform', 'interaction-task', 'runtime-host-pi'] },
        status: { type: 'string', const: 'not_ready' },
        reason: { type: 'string', enum: ['foundation_only', 'pi_not_integrated', 'runtime_not_verified', 'runtime_not_configured', 'configuration_unavailable'] },
      },
    },
    { type: 'object', additionalProperties: false,
      required: ['protocolVersion', 'service', 'status', 'providerConnectivity'],
      properties: {
        protocolVersion: { type: 'string', const: PROTOCOL_VERSION },
        service: { type: 'string', enum: ['control-plane', 'platform', 'interaction-task', 'runtime-host-pi'] },
        status: { type: 'string', const: 'ready' },
        providerConnectivity: { type: 'string', const: 'unverified' },
      },
    },
  ],
} as const;

export { RUNTIME_CONTRACT_VERSION, THINKING_LEVELS, isThinkingLevel, resolvedThinkingLevel } from './runtime-common.js';
export type * from './runtime-common.js';
export type * from './runtime-provisioning.js';
export type * from './runtime-session.js';
export type * from './runtime-execution.js';
export type * from './task-actions.js';
export type * from './runtime-maintenance.js';

export * from './employee-avatar.js';
export type * from './runtime-records.js';

export type * from "./runtime-materials.js";

export {MAX_RUNTIME_MATERIAL_BYTES} from './runtime-materials.js';
export * from './human-confirmation.js';
export type * from './group-sharing.js';
export type * from './work-items.js';
export {WORK_ITEM_TOOLS} from './work-items.js';

export * from './model-input.js';
export * from './task-title.js';
