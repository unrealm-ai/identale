import test from 'node:test';
import assert from 'node:assert/strict';
import {ChannelTaskAuthorization} from '../dist/channel-loop/authorization.js';
test('authorization receipt is scoped to actor, channel conversation, thread and originating event',async()=>{
 let revision=1,now=1000;
 const binding={connectionId:'c',workspaceId:'w',entityId:'e',appId:'app',bindingVersion:'binding',connection:{tenantId:'tenant'}};
 const web={getDirectoryAccess(){return{revision};},list(){return[];},async usableChannel(){return[];}};
 const connections={async resolveBinding(){return binding;},async authorizeInvocation(){},currentBindingVersion(){return'binding';}};
 const auth=new ChannelTaskAuthorization({one(){return{id:'e'};}},web,connections,()=>now);
 const scope={workspaceId:'w',entityId:'e',principal:{kind:'channel',channelType:'feishu',tenantId:'tenant',identityNamespace:'open_id',externalUserId:'alice'},source:{channelType:'feishu',tenantId:'tenant',installationId:'c',applicationId:'app',connectionId:'c',bindingVersion:'binding',conversationId:'group-a',conversationKind:'group',sourceEventId:'event-a',threadId:'thread-a'}};
 await auth.refreshAuthorization(scope);assert.doesNotThrow(()=>auth.authorizeEntity(scope));
 for(const changed of [{conversationId:'group-b'},{sourceEventId:'event-b'},{threadId:'thread-b'}])assert.throws(()=>auth.authorizeEntity({...scope,source:{...scope.source,...changed}}),/channel_authorization_required/);
 assert.throws(()=>auth.authorizeEntity({...scope,principal:{...scope.principal,externalUserId:'bob'}}),/channel_authorization_required/);
 revision++;assert.throws(()=>auth.authorizeEntity(scope),/channel_authorization_required/);await auth.refreshAuthorization(scope);now+=15001;assert.throws(()=>auth.authorizeEntity(scope),/channel_authorization_required/);
});
