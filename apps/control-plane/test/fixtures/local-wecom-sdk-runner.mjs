import {WSClient} from '@wecom/aibot-node-sdk';
import {runSdkRunner} from '../../dist/adapters/channels/ingress/sdk-runner-host.js';
const endpoint=process.env.TEST_LOCAL_WS;
if(!endpoint||new URL(endpoint).hostname!=='127.0.0.1')throw new Error('local fixture required');
runSdkRunner({wecom:options=>new WSClient({...options,wsUrl:endpoint,heartbeatInterval:100})});
