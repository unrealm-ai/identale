import {ChannelError, type SendChannelMessage} from '@dentity/application';

export type NativeAttachment = NonNullable<SendChannelMessage['attachment']>;
/** Local transport limits, not a claim about all vendor-supported media formats. */
export function validateNativeAttachment(attachment: NativeAttachment, limits: {image:number;file:number}): void {
  if (!attachment || !['image','file'].includes(attachment.kind) || !(attachment.bytes instanceof Uint8Array) || !attachment.bytes.byteLength ||
      typeof attachment.name !== 'string' || !attachment.name.trim() || attachment.name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(attachment.name) ||
      typeof attachment.mediaType !== 'string' || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(attachment.mediaType)) {
    throw new ChannelError('invalid_request','invalid_native_attachment');
  }
  if (attachment.bytes.byteLength > limits[attachment.kind]) throw new ChannelError('invalid_request','native_attachment_too_large');
  if (attachment.kind !== 'image') return;
  const size = imageDimensions(attachment.bytes,attachment.mediaType);
  const maximum = attachment.mediaType === 'image/gif' ? 2000 : 12000;
  if (!size || !size.width || !size.height || size.width > maximum || size.height > maximum) throw new ChannelError('invalid_request','native_image_dimensions_invalid');
}

/** Bounded header parsing. Never decode pixels or trust a filename for media type. */
function imageDimensions(bytes:Uint8Array,type:string):{width:number;height:number}|undefined {
  const b=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(type==='image/png') {
    if(b.length<33||!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||b.readUInt32BE(8)!==13||b.toString('ascii',12,16)!=='IHDR')return;
    return {width:b.readUInt32BE(16),height:b.readUInt32BE(20)};
  }
  if(type==='image/gif') {
    if(b.length<13||!['GIF87a','GIF89a'].includes(b.toString('ascii',0,6)))return;
    return {width:b.readUInt16LE(6),height:b.readUInt16LE(8)};
  }
  if(type==='image/webp') {
    if(b.length<20||b.toString('ascii',0,4)!=='RIFF'||b.toString('ascii',8,12)!=='WEBP'||b.readUInt32LE(4)+8!==b.length)return;
    const chunk=b.toString('ascii',12,16),length=b.readUInt32LE(16);
    if(length+20>b.length)return;
    if(chunk==='VP8X'&&length===10&&b.length>=30)return {width:1+b.readUIntLE(24,3),height:1+b.readUIntLE(27,3)};
    if(chunk==='VP8 '&&length>=10&&b[23]===0x9d&&b[24]===0x01&&b[25]===0x2a)return {width:b.readUInt16LE(26)&0x3fff,height:b.readUInt16LE(28)&0x3fff};
    if(chunk==='VP8L'&&length>=5&&b[20]===0x2f){const bits=b.readUInt32LE(21);return {width:1+(bits&0x3fff),height:1+((bits>>>14)&0x3fff)};}
    return;
  }
  if(type==='image/jpeg') {
    if(b.length<4||b[0]!==255||b[1]!==216)return;
    let offset=2;
    while(offset+4<=b.length){
      if(b[offset++]!==255)return;
      while(offset<b.length&&b[offset]===255)offset++;
      const marker=b[offset++];
      if(marker===undefined||marker===0xda||marker===0xd9)return;
      if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
      if(offset+2>b.length)return;
      const length=b.readUInt16BE(offset);
      if(length<2||offset+length>b.length)return;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if(length<8)return;
        return {height:b.readUInt16BE(offset+3),width:b.readUInt16BE(offset+5)};
      }
      offset+=length;
    }
    return;
  }
  throw new ChannelError('unsupported','native_image_format_not_validated');
}
