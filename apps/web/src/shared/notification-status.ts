export interface NotificationState{generationState?:string;deliveryState?:string;status?:string;error?:string|null}
export function notificationStatus(n:NotificationState):string{
 const generation=n.generationState;if(generation&&generation!=='published')return({pending:'等待整理回告',generating:'正在整理回告',ready:'等待发布',failed:'回告生成失败',unknown:'生成结果待核对'}as Record<string,string>)[generation]??'等待处理';
 return({not_started:'尚未发送',queued:'等待发送',pending:'等待发送',sending:'正在发送',sent:'已发送',published:'已发布',failed:'发送失败',blocked:'暂不可用',unknown:'送达待核对'}as Record<string,string>)[n.deliveryState??n.status??'']??'等待处理';
}
