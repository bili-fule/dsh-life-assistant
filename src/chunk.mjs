// Long inputs are windowed instead of being handed over whole. A single tool
// result must never exceed the model's capacity, and the source stays recoverable
// by offset: nothing is summarised away, nothing is silently dropped.
export const CHUNK_DEFAULT=12000
export const CHUNK_MAX=24000

export function readChunk(text,{offset=0,characters=CHUNK_DEFAULT}={}) {
  if(typeof text!=='string')throw Error('文本无效')
  if(!Number.isSafeInteger(offset)||offset<0)throw Error('分页起点无效')
  if(!Number.isInteger(characters)||characters<1||characters>CHUNK_MAX)throw Error('分页长度无效')
  const total=text.length
  const piece=offset>=total?'':text.slice(offset,offset+characters)
  const next=offset+piece.length<total?offset+piece.length:null
  return {text:piece,offset,total,length:piece.length,truncated:next!==null,next}
}
