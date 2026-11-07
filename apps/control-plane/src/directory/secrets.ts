import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
export interface SealedDirectoryCredential {ciphertext:string;nonce:string;tag:string}
/** Deployment key; purpose/workspace/source/revision are authenticated, never model-visible. */
export class DirectoryCredentialVault {
  private readonly key:Buffer|undefined;
  constructor(key?:Uint8Array){if(key&&key.byteLength!==32)throw new Error('directory_secret_key_invalid');this.key=key?Buffer.from(key):undefined;}
  seal(secret:string,scope:readonly (string|number)[]):SealedDirectoryCredential{if(!this.key)throw new Error('directory_secret_key_unconfigured');const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,nonce);cipher.setAAD(Buffer.from(JSON.stringify(['directory-app-secret-v1',...scope])));const ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);return{ciphertext:ciphertext.toString('base64'),nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64')};}
  open(value:SealedDirectoryCredential,scope:readonly (string|number)[]):string{if(!this.key)throw new Error('directory_secret_key_unconfigured');const cipher=createDecipheriv('aes-256-gcm',this.key,Buffer.from(value.nonce,'base64'));cipher.setAAD(Buffer.from(JSON.stringify(['directory-app-secret-v1',...scope])));cipher.setAuthTag(Buffer.from(value.tag,'base64'));return Buffer.concat([cipher.update(Buffer.from(value.ciphertext,'base64')),cipher.final()]).toString('utf8');}
  get available(){return !!this.key;}
}
