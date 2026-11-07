process.on('SIGTERM',()=>{});
process.on('message',message=>{
  if(message.type!=='start') return;
  process.send({type:'event',generation:'wrong-generation',requestId:'wrong',envelope:{}});
  process.send({type:'status',generation:message.session.generation,status:{state:'connected',changedAt:0,error:'SECRET-ticket'}});
});
setInterval(()=>{},1000);
