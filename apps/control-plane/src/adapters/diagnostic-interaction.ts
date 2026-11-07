import {diagnosticFailure,type DiagnosticPort,type InteractionService} from '@dentity/application';

/** Decorates timing only; the service retains every authorization and storage decision. */
export function diagnosticInteraction(service:InteractionService,diagnostics:DiagnosticPort):InteractionService {
 return{...service,
  events:async(...args)=>{const at=Date.now();try{const result=await service.events(...args);if(result.events.length)diagnostics.event({stage:'interaction.events',phase:'end',outcome:'success',durationMs:Date.now()-at,turnId:args[2],conversationId:args[1]});for(const event of result.events)if(event.type==='output')diagnostics.event({stage:'reply.persist',phase:'point',outcome:'success',messageId:event.outputId,turnId:args[2],conversationId:args[1]});return result;}catch(error){diagnostics.event({stage:'interaction.events',phase:'end',outcome:'failure',...diagnosticFailure(error)});throw error;}},
  createTurn:(...args)=>diagnostics.span('interaction.submit',async()=>{const result=await service.createTurn(...args);diagnostics.event({stage:'interaction.submit',phase:'point',turnId:result.turn.id,conversationId:args[1]});return result;}),
  getTurn:async(...args)=>{const start=Date.now();try{const result=await service.getTurn(...args);diagnostics.event({stage:'interaction.poll',phase:'end',outcome:'success',state:result.turn.status,durationMs:Date.now()-start,turnId:result.turn.id,conversationId:args[1]});if(result.turn.status==='succeeded')diagnostics.event({stage:'reply.persist',phase:'point',outcome:'success',turnId:result.turn.id,conversationId:args[1]});return result;}catch(error){diagnostics.event({stage:'interaction.poll',phase:'end',outcome:'failure',durationMs:Date.now()-start,...diagnosticFailure(error)});throw error;}},
 };
}
