import{statfsSync}from'node:fs';
import{dirname}from'node:path';
import type{DiagnosticPort}from'@dentity/application';
/** Warning only, never a message quota or queue admission decision. */
export function diskObserver(databasePath:string,diagnostics:DiagnosticPort){let last=-Infinity;return(at:number)=>{if(at-last>=60000){last=at;try{const fs=statfsSync(dirname(databasePath)),available=fs.bavail*fs.bsize;diagnostics.event({stage:'diagnostic.health',phase:'point',state:'running',...(available<256*1024*1024?{outcome:'failure' as const,category:'storage' as const}:{}),metrics:{diskAvailableBytes:available,diskLowWater:available<256*1024*1024?1:0}});}catch{diagnostics.event({stage:'diagnostic.health',phase:'point',outcome:'failure',category:'storage'});}}return{deleted:0,more:false};};}
