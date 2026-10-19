export function qqMediaHost(host){return ['qq.com','qq.com.cn','qpic.cn','gtimg.cn','gtimg.com'].some(domain=>host===domain||host.endsWith('.'+domain))}
export function imageExtension(bytes){
 if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png'
 if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'jpg'
 if(bytes.length>=6&&/^GIF8[79]a$/.test(bytes.toString('ascii',0,6)))return 'gif'
 if(bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'webp'
 throw Error('附件内容不是支持的图片格式')
}
