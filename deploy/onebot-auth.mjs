import {createHash,createHmac,timingSafeEqual} from 'node:crypto'
const digest=value=>createHash('sha256').update(value).digest()
export function authorizedEvent(headers,body,token){
 if(typeof token!=='string'||token.length<24)return false
 if(typeof headers.authorization==='string'&&timingSafeEqual(digest(headers.authorization),digest('Bearer '+token)))return true
 const expected='sha1='+createHmac('sha1',token).update(body).digest('hex')
 return typeof headers['x-signature']==='string'&&timingSafeEqual(digest(headers['x-signature']),digest(expected))
}
