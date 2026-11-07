import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { InteractionService, TaskScope } from '@dentity/application';
/** Transport only: scope extraction, API envelopes and response codes. */
export function registerInteractionRoutes(server:FastifyInstance,service:InteractionService,scope:(request:FastifyRequest)=>TaskScope,base='/api/workspaces/:workspaceId/entities/:entityId') {
  server.post(`${base}/conversations`,(request,reply)=>{const result=service.create(scope(request),request.body);return reply.code(result.created?201:200).send({conversation:result.conversation});});
  server.get(`${base}/conversations`,request=>service.list(scope(request)));
  server.get(`${base}/conversations/:conversationId/messages`,request=>service.messages(scope(request),(request.params as {conversationId:string}).conversationId));
  server.post(`${base}/conversations/:conversationId/turns`,async(request,reply)=>reply.code(202).send(await service.createTurn(scope(request),(request.params as {conversationId:string}).conversationId,request.body)));
  server.get(`${base}/conversations/:conversationId/turns/:turnId`,request=>{const p=request.params as {conversationId:string;turnId:string};return service.getTurn(scope(request),p.conversationId,p.turnId);});
  server.post(`${base}/conversations/:conversationId/turns/:turnId/interrupt`,request=>{const p=request.params as {conversationId:string;turnId:string};return service.interrupt(scope(request),p.conversationId,p.turnId,request.body);});
}
