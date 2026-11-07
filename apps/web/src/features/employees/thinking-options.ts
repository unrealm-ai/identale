export type ExecutionThinkingLevel = 'none' | 'low' | 'medium' | 'high';
export const executionThinkingOptions = [{value:'none',label:'无'},{value:'low',label:'低'},{value:'medium',label:'中'},{value:'high',label:'高'}];
export const thinkingLabel=(level:ExecutionThinkingLevel)=>executionThinkingOptions.find(option=>option.value===level)?.label??level;
