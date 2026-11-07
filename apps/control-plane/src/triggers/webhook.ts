import type {TriggerAcceptancePort,TriggerAction,WebhookTriggerPort} from '@dentity/application';
import type {TriggerStore} from './store.js';
import {parseTriggerCommand,TRIGGER_BODY_LIMIT,TriggerError,triggerIdentifier,verifyWebhookSignature} from './protocol.js';
/** Only the fixed protocol enters here; GitHub uses its own raw-body adapter. */
export class FixedWebhookAdapter implements WebhookTriggerPort {
  constructor(private readonly bindings:TriggerStore,private readonly acceptance:TriggerAcceptancePort){}
  async receive(input:Parameters<WebhookTriggerPort['receive']>[0]){
    if(!input.secure)throw new TriggerError(400,'trigger_https_required');
    if(input.method!=='POST'||!triggerIdentifier(input.triggerId)||input.path!=='/api/triggers/webhook/'+input.triggerId)throw new TriggerError(400,'invalid_trigger_route');
    if(!input.body.byteLength||input.body.byteLength>TRIGGER_BODY_LIMIT)throw new TriggerError(400,'invalid_trigger_body');
    const keyId=input.headers['x-key-id'];if(!triggerIdentifier(keyId))throw new TriggerError(401,'trigger_authentication_failed');
    const binding=this.bindings.binding(input.triggerId);if(!binding||binding.type!=='webhook'||JSON.parse(binding.config_json).adapter!=='generic')throw new TriggerError(401,'trigger_authentication_failed');
    const secret=this.bindings.secret(input.triggerId,keyId),hash=verifyWebhookSignature({triggerId:input.triggerId,secret,body:input.body,timestamp:input.headers['x-timestamp'],signature:input.headers['x-signature'],receivedAt:input.receivedAt});
    if(binding.enabled!==1)throw new TriggerError(403,'trigger_disabled');
    const command=parseTriggerCommand(input.body),allowed=JSON.parse(binding.allowed_actions_json) as TriggerAction[];
    if(command.entityId!==undefined&&command.entityId!==binding.entity_id||!allowed.includes(command.action))throw new TriggerError(403,'trigger_target_forbidden');
    return this.acceptance.accept({triggerId:binding.id,sourceKind:'webhook',sourceEvidenceRef:hash,occurredAt:Number(input.headers['x-timestamp']),receivedAt:input.receivedAt,bodyHash:hash,command});
  }
}
