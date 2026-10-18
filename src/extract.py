"""Bounded local document and chat archive extraction. No macros are executed."""
import sys, json, pathlib, zipfile, re, hashlib, subprocess
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
if hasattr(sys.stdout,'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

MAX_TEXT = 30000
MAX_EXPANDED = 64 * 1024 * 1024
MAX_ENTRIES = 100

def xml_text(data):
    if b'<!DOCTYPE' in data.upper():
        raise ValueError('不允许带外部实体的 XML')
    return ET.fromstring(data)

class HTMLText(HTMLParser):
    def __init__(self):
        super().__init__(); self.parts=[]; self.skip=0
    def handle_starttag(self, tag, attrs):
        if tag in ('script','style'): self.skip+=1
        if tag in ('p','div','br','li','tr','h1','h2','h3'): self.parts.append('\n')
    def handle_endtag(self, tag):
        if tag in ('script','style'): self.skip=max(0,self.skip-1)
    def handle_data(self, data):
        if not self.skip:self.parts.append(data)

def extract(path):
    p=pathlib.Path(path).resolve(); ext=p.suffix.lower(); children=[]
    if p.stat().st_size>32*1024*1024: raise ValueError('单个文件超过 32 MiB')
    if ext=='.pdf':
        r=subprocess.run(['pdftotext','-layout','-f','1','-l','40',str(p),'-'],capture_output=True,timeout=30)
        if r.returncode:raise ValueError('PDF 文本提取失败：'+r.stderr.decode(errors='replace')[:300])
        text=r.stdout.decode('utf-8',errors='replace')
        if not text.strip():
            out=p.parent/('pdf-pages-'+hashlib.sha256(p.read_bytes()).hexdigest()[:12]);out.mkdir(exist_ok=True)
            r=subprocess.run(['pdftoppm','-f','1','-l','4','-scale-to','1600','-png',str(p),str(out/'page')],capture_output=True,timeout=45)
            children=[str(f) for f in sorted(out.glob('*.png'))]
            text='扫描版 PDF，前四页已转换为图片供识别。'
    elif ext in ('.docx','.pptx','.xlsx','.odt'):
        with zipfile.ZipFile(p) as z:
            if sum(i.file_size for i in z.infolist())>MAX_EXPANDED:raise ValueError('文档解压体积过大')
            if ext=='.docx':
                root=xml_text(z.read('word/document.xml'));ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
                text='\n'.join(''.join(n.text or '' for n in para.findall('.//w:t',ns)) for para in root.findall('.//w:p',ns))
            elif ext=='.pptx':
                names=sorted(n for n in z.namelist() if re.match(r'ppt/slides/slide\d+\.xml$',n));text='\n'.join('\n'.join(xml_text(z.read(n)).itertext()) for n in names[:60])
            elif ext=='.odt':text='\n'.join(xml_text(z.read('content.xml')).itertext())
            else:
                ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
                shared=[]
                if 'xl/sharedStrings.xml' in z.namelist():shared=[''.join(t.text or '' for t in si.findall('.//s:t',ns)) for si in xml_text(z.read('xl/sharedStrings.xml')).findall('s:si',ns)]
                parts=[]
                for name in sorted(n for n in z.namelist() if re.match(r'xl/worksheets/sheet\d+\.xml$',n))[:30]:
                    parts.append('工作表 '+name)
                    for row in xml_text(z.read(name)).findall('.//s:row',ns)[:2000]:
                        cells=[]
                        for cell in row.findall('s:c',ns):
                            v=cell.find('s:v',ns);value=v.text if v is not None else ''.join(cell.itertext())
                            if cell.get('t')=='s' and value and value.isdigit():value=shared[int(value)] if int(value)<len(shared) else value
                            cells.append(cell.get('r','')+':'+str(value or ''))
                        parts.append('\t'.join(cells))
                text='\n'.join(parts)
    elif ext=='.doc':
        r=subprocess.run(['antiword',str(p)],capture_output=True,timeout=20);text=r.stdout.decode('utf-8',errors='replace')
        if r.returncode:raise ValueError('旧版 Word 读取失败')
    elif ext=='.zip':
        out=p.parent/('unpacked-'+hashlib.sha256(p.read_bytes()).hexdigest()[:12]);out.mkdir(mode=0o700,exist_ok=True)
        with zipfile.ZipFile(p) as z:
            members=z.infolist()
            if len(members)>MAX_ENTRIES or sum(i.file_size for i in members)>MAX_EXPANDED:raise ValueError('压缩包文件数或展开体积超过限制')
            for i in members:
                if i.is_dir():continue
                name=i.filename.replace('\\','/')
                if name.startswith('/') or '..' in pathlib.PurePosixPath(name).parts or re.match(r'^[a-zA-Z]:',name):raise ValueError('压缩包包含越界路径')
                if (i.external_attr>>16)&0o170000==0o120000:raise ValueError('压缩包不允许符号链接')
                target=(out/name).resolve()
                if not target.is_relative_to(out.resolve()):raise ValueError('压缩包路径越界')
                target.parent.mkdir(parents=True,exist_ok=True)
                target.write_bytes(z.read(i));target.chmod(0o600);children.append(str(target))
        text='聊天记录/压缩包包含：\n'+'\n'.join(pathlib.Path(f).relative_to(out).as_posix() for f in children)
    elif ext in ('.html','.htm'):
        parser=HTMLText();parser.feed(p.read_text(encoding='utf-8',errors='replace'));text=''.join(parser.parts)
    elif ext in ('.txt','.md','.csv','.tsv','.json','.jsonl','.yaml','.yml','.xml','.log','.py','.js','.mjs','.sh','.ini','.conf'):
        data=p.read_bytes()
        if data.startswith((b'\xff\xfe',b'\xfe\xff')):text=data.decode('utf-16')
        else:
            try:text=data.decode('utf-8-sig')
            except UnicodeDecodeError:text=data.decode('gb18030',errors='replace')
    else:
        raise ValueError('暂不能直接提取此格式；文件已保存在工作目录，可用 Shell 工具处理：'+ext)
    return {'text':text[:MAX_TEXT], 'truncated':len(text)>MAX_TEXT, 'children':children}

if __name__=='__main__':
    try:result=extract(sys.argv[1])
    except Exception as e:result={'error':str(e)[:500],'text':'','children':[]}
    print(json.dumps(result,ensure_ascii=False))
