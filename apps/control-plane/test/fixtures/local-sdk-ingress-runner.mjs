// Explicitly local-only test fixture. Production entrypoint has no endpoint override.
import {WSClient} from '@larksuiteoapi/node-sdk';
import {DWClient} from 'dingtalk-stream';
import {runSdkRunner} from '../../dist/adapters/channels/ingress/sdk-runner-host.js';
const endpoint = process.env.TEST_LOCAL_WS;
if (!endpoint || new URL(endpoint).hostname !== '127.0.0.1') throw new Error('local fixture required');
runSdkRunner({
  lark: options => new WSClient({...options, httpInstance: {
    request: async () => {if(process.env.TEST_DISCOVERY_DELAY) await new Promise(resolve=>setTimeout(resolve,1000)); return ({code: Number(process.env.TEST_AUTH_CODE ?? 0), data: {URL: `${endpoint}?device_id=test-device&service_id=1`, ClientConfig: {PingInterval: 60, ReconnectCount: 2, ReconnectInterval: 0.05, ReconnectNonce: 0}}, msg:'test-provider-secret'});},
  }}),
  ding: options => {
    const client = new DWClient(options);
    client.getEndpoint = async () => {if(process.env.TEST_DISCOVERY_DELAY) await new Promise(resolve=>setTimeout(resolve,1000)); if(process.env.TEST_AUTH_CODE) throw {response:{status:Number(process.env.TEST_AUTH_CODE)}}; client.dw_url = endpoint; return client;};
    return client;
  },
});
