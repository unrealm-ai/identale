/** Isolated real HTTP/SQLite/static Web fixture. No runtime dispatch, model calls or real channels. */
import {createServer,request} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {taskActivityFixture} from '../helpers/task-activity-fixture.mjs';
const dist=resolve('apps/web/dist');let fixture;
const front=createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/')){
  const proxy=request({host:'127.0.0.1',port:fixture.app.server.address().port,path:req.url,method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});proxy.on('error',()=>{res.writeHead(502);res.end();});req.pipe(proxy);return;
 }
 const candidate=resolve(dist,'.'+url.pathname),file=candidate.startsWith(dist+sep)&&existsSync(candidate)&&extname(candidate)?candidate:resolve(dist,'index.html');
 res.writeHead(200,{'content-type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[extname(file)]??'application/octet-stream','cache-control':'no-store'});res.end(await readFile(file));
}catch{res.writeHead(500);res.end('Isolated fixture failure');}});
await new Promise(r=>front.listen(0,'127.0.0.1',r));const origin='http://localhost:'+front.address().port;
fixture=await taskActivityFixture(null,origin,{directorySync:{automatic:false},triggers:{automatic:false},maintenance:{enabled:false}});
await fixture.app.listen({host:'127.0.0.1',port:0});
const rows=[['named','核对客户退款材料', '完整执行说明：\n'+'逐项核对所有授权资料，保留业务审批要求。'.repeat(160)],['legacy',null,'历史任务没有独立标题，需要保证中英文长文本不会挤压状态与创建时间。'.repeat(60)],['english',null,'UnbrokenLongExecutionInstruction'.repeat(160)],['emoji','核对👨‍👩‍👧‍👦资料并汇总结果','保留组合字符与完整要求'],['trigger','日报汇总 2611051557','生成指定日期的日报并遵守所有原始限制。']];
for(const[id,title,input]of rows){const task=fixture.seedTask(id,fixture.own,id==='named'?'planned':'succeeded',input,Date.parse('2026-11-05T07:57:00Z'));if(title)fixture.repo.setTaskTitle(task.id,title);}
const info={origin,workspaceId:fixture.owner.workspace.id,entityId:fixture.entity.id,conversationId:fixture.own.id,username:'activity-owner',password:'Synthetic password 2026!',scope:'isolated test data only'};
await writeFile('/tmp/identity-task-title-browser.json',JSON.stringify(info,null,2));console.log(JSON.stringify(info));
async function close(){await new Promise(r=>{front.close(r);front.closeAllConnections();});await fixture.close();process.exit(0);}
process.on('SIGTERM',close);process.on('SIGINT',close);
