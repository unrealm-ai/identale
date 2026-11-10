import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveChannelConfigurationCapabilities as resolve} from '../dist/employee-channels/capabilities.js';
const record=(extra={})=>({provider:'feishu',enabled:true,status:'verified',directoryStatus:'available',...extra});
const granted={supported:true,availability:'available'};
test('group context setting never substitutes ordinary-message scope evidence',()=>{
 const result=resolve(record({context:{groupListenEnabled:true}}));
 assert.equal(result.keywordTriggers.availability,'authorization_required');
 assert.equal(result.recentGroupContext.availability,'authorization_required');
 const scopes={checks:[{id:'scope_inventory',scopeInventory:[{scope:'im:message.group_msg',identity:'tenant',status:'granted'}]}]};
 const actual=resolve(record({context:{groupListenEnabled:false},validation:scopes}));
 assert.equal(actual.keywordTriggers.availability,'available');
 assert.equal(actual.recentGroupContext.availability,'available');
});
test('disabled and pending robots never claim configured message/media availability',()=>{
 const leaf={private:{image:granted,file:granted},group:{image:granted,file:granted}};
 const declaration={privateMessageEvents:granted,mentionEvents:granted,ordinaryMessageEvents:granted,media:{inbound:leaf,outbound:leaf}};
 for(const r of [record({enabled:false}),record({status:'pending_verification'})]){
  const result=resolve(r,declaration);
  assert.equal(result.privateMessages.availability,'authorization_required');
  assert.equal(result.media.outbound.group.image.availability,'authorization_required');
 }
 assert.equal(declaration.media.outbound.group.image.availability,'available');
});
test('channel and business support remain independent from online and directory status',()=>{
 for(const provider of ['dingtalk','wecom']){
  const result=resolve(record({provider}));
  assert.equal(result.keywordTriggers.supported,false);
  assert.notEqual(result.meetingRead.availability,'available');
  assert.notEqual(result.documentRead.availability,'available');
  assert.equal(result.directoryRead.availability,provider==='wecom'?'unknown':'available');
  if(provider==='wecom')assert.match(result.directoryRead.reason,/不支持部门或全量目录/);
  assert.equal(result.media.outbound.private.file.supported,true);
  if(provider==='dingtalk')assert.equal(result.media.inbound.group.file.supported,false);
 }
 assert.equal(resolve(record({provider:'dingtalk'})).documentRead.supported,true);
 assert.match(resolve(record()).documentRead.reason,/应用身份/);
 assert.match(resolve(record()).documentRead.reason,/无需先登录个人账号/);
 assert.notEqual(resolve(record()).documentRead.availability,'available');
 assert.equal(resolve(record({provider:'wecom'})).groupMentions.supported,false);
 assert.equal(resolve(record({provider:'wecom'})).directedGroupMessages.supported,true);
});

test('legacy adapters with no media declaration stay unknown rather than inheriting vendor support',()=>{assert.equal(resolve(record(),{ordinaryMessageEvents:granted}).media,undefined);});
