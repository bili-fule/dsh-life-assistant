// Preserve Markdown at the channel boundary, preferring paragraphs/lines and balancing fenced code across messages.
export function markdownChunks(text,limit=1400) {
  if(!Number.isInteger(limit)||limit<160)throw Error('Markdown 分段预算过小')
  if(text.length<=limit)return [text]
  const chunks=[];let rest=text,fence=null
  while(rest.length) {
    const prefix=fence?fence+'\n':'',budget=limit-prefix.length-80
    let end=Math.min(rest.length,budget)
    if(end<rest.length) {
      const paragraph=rest.lastIndexOf('\n\n',end),line=rest.lastIndexOf('\n',end)
      if(paragraph>budget/3)end=paragraph+2
      else if(line>0)end=line+1
      else {
        // Keep ordinary links and inline code whole when a long line crosses the budget.
        for(const match of rest.matchAll(/\[[^\]\n]*\]\([^\n)]*\)|`[^`\n]+`/g))if(match.index<end&&match.index+match[0].length>end&&match.index>0){end=match.index;break}
        if(/[\uD800-\uDBFF]/.test(rest[end-1]??''))end--
      }
    }
    const part=rest.slice(0,end);rest=rest.slice(end)
    for(const line of part.split('\n')) {
      const m=line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/)
      if(m&&m[1].length<=32&&!fence)fence=m[1]+m[2].trim().slice(0,40)
      else if(m&&fence&&m[1][0]===fence[0]&&m[1].length>=(fence.match(/^(`+|~+)/)?.[0].length??3))fence=null
    }
    const suffix=rest.length&&fence?'\n'+fence.match(/^(`+|~+)/)[0]:''
    chunks.push(prefix+part+suffix)
  }
  return chunks
}
