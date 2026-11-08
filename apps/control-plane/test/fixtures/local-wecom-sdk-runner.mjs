import {WSClient} from '@wecom/aibot-node-sdk';
import {runSdkRunner} from '../../dist/adapters/channels/ingress/sdk-runner-host.js';
const endpoint=process.env.TEST_LOCAL_WS;
if(!endpoint||new URL(endpoint).hostname!=='127.0.0.1')throw new Error('local fixture required');
// Keep the official 30s heartbeat default: the local mock server shares the
// test process with synchronous SQLite work. Accelerating it to 100ms creates
// artificial transport loss after only two missed pongs under parallel tests.
runSdkRunner({wecom:options=>new WSClient({...options,wsUrl:endpoint})});
