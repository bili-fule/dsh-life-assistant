"""Read a WeChat Pay XLSX without executing workbook formulas or macros."""
import sys, json, zipfile, hashlib, re
from pathlib import Path
from decimal import Decimal
from datetime import datetime, timedelta
from xml.etree import ElementTree as ET

def parse(path):
    p=Path(path)
    if p.stat().st_size>40*1024*1024: raise ValueError('账单超过40MiB')
    ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    with zipfile.ZipFile(p) as z:
        if len(z.infolist())>10000 or sum(x.file_size for x in z.infolist())>100*1024*1024: raise ValueError('账单解压规模过大')
        shared=[]
        if 'xl/sharedStrings.xml' in z.namelist():
            shared=[''.join(x.itertext()) for x in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('s:si',ns)]
        sheet=ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
        rows=[]
        for row in sheet.findall('.//s:sheetData/s:row',ns):
            values={}
            for cell in row.findall('s:c',ns):
                if cell.find('s:f',ns) is not None: raise ValueError('账单含公式，不自动记账')
                col=re.sub(r'\d','',cell.attrib['r']);v=cell.find('s:v',ns)
                value=v.text if v is not None else ''
                if cell.attrib.get('t')=='s': value=shared[int(value)]
                elif cell.attrib.get('t')=='inlineStr': value=''.join(cell.find('s:is',ns).itertext())
                values[col]=value or ''
            rows.append((int(row.attrib['r']),values))
    header=next((i for i,(_,r) in enumerate(rows) if r.get('A')=='交易时间' and r.get('I')=='交易单号'),None)
    if header is None: raise ValueError('不是支持的微信支付账单')
    control={}
    for _,r in rows[:header]:
        m=re.match(r'(收入|支出|中性交易)：(\d+)笔\s*([\d.]+)元',r.get('A',''))
        if m: control[{'收入':'income','支出':'expense','中性交易':'transfer'}[m[1]]]={'count':int(m[2]),'cents':int(Decimal(m[3])*100)}
    entries=[]
    for number,r in rows[header+1:]:
        if not r.get('I'): continue
        raw=r['A']
        day=(datetime(1899,12,30)+timedelta(days=float(raw))).strftime('%Y-%m-%d') if re.fullmatch(r'\d+(\.\d+)?',raw) else raw[:10]
        kind={'收入':'income','支出':'expense','/':'transfer'}.get(r.get('E'))
        if kind=='income' and '退款' in r.get('B',''): kind='refund'
        if kind is None: raise ValueError('未知收支方向')
        amount=Decimal(r['F'].replace('¥','').replace('￥','').replace(',',''))
        if amount!=amount.quantize(Decimal('.01')) or amount<=0: raise ValueError('金额精度无效')
        category='退款' if kind=='refund' else '账户划转' if kind=='transfer' else '未分类'
        entries.append({'row':number,'externalId':r['I'],'day':day,'kind':kind,'amount':str(amount),'category':category,'counterparty':r.get('C',''),'description':r.get('D',''),'account':r.get('G',''),'status':r.get('H','')})
    return {'digest':hashlib.sha256(p.read_bytes()).hexdigest(),'label':p.name,'rows':entries,'control':control}

if __name__=='__main__':
    print(json.dumps(parse(sys.argv[1]),ensure_ascii=False))
