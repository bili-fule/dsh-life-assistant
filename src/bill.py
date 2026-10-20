"""Parse WeChat Pay XLSX and Alipay transaction CSV bills without executing formulas or macros.

Both formats are turned into the same payload for Ledger.importBill: exact-cent rows plus a
control block. WeChat publishes consistent income/expense/neutral totals, so its control block is
reconciled strictly. Alipay's own footer warns that footer totals and row sums may differ, so the
Alipay control block only proves completeness (row count) and the split between settled and
skipped rows; settled totals are recomputed from the rows.
"""
import sys, json, zipfile, hashlib, re, csv, io
from pathlib import Path
from decimal import Decimal, InvalidOperation
from datetime import datetime, timedelta
from xml.etree import ElementTree as ET

MAX_BYTES = 40 * 1024 * 1024
ALIPAY_REQUIRED = ('交易时间', '交易分类', '交易对方', '商品说明', '收/支', '金额', '收/付款方式', '交易状态', '交易订单号')
ALIPAY_SUCCESS = ('交易成功', '退款成功')


def fail(message):
    raise ValueError(message)


def money(value):
    try:
        amount = Decimal(str(value).strip().replace('¥', '').replace('￥', '').replace(',', ''))
    except (InvalidOperation, AttributeError):
        fail('金额格式无效')
    if amount != amount.quantize(Decimal('.01')) or amount <= 0:
        fail('金额精度无效')
    return amount


def day_of(value):
    text = str(value).strip()
    day = text[:10]
    try:
        datetime.strptime(day, '%Y-%m-%d')
    except ValueError:
        fail('日期无效')
    return day


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_size(path):
    if path.stat().st_size > MAX_BYTES:
        fail('账单超过40MiB')


def parse_wechat(path):
    ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    with zipfile.ZipFile(path) as archive:
        if len(archive.infolist()) > 10000 or sum(item.file_size for item in archive.infolist()) > 100 * 1024 * 1024:
            fail('账单解压规模过大')
        shared = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            shared = [''.join(node.itertext()) for node in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('s:si', ns)]
        sheet = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
        rows = []
        for row in sheet.findall('.//s:sheetData/s:row', ns):
            values = {}
            for cell in row.findall('s:c', ns):
                if cell.find('s:f', ns) is not None:
                    fail('账单含公式，不自动记账')
                column = re.sub(r'\d', '', cell.attrib['r'])
                text = cell.find('s:v', ns)
                value = text.text if text is not None else ''
                if cell.attrib.get('t') == 's':
                    value = shared[int(value)]
                elif cell.attrib.get('t') == 'inlineStr':
                    value = ''.join(cell.find('s:is', ns).itertext())
                values[column] = value or ''
            rows.append((int(row.attrib['r']), values))
    header = next((i for i, (_, row) in enumerate(rows) if row.get('A') == '交易时间' and row.get('I') == '交易单号'), None)
    if header is None:
        fail('不是支持的微信支付账单')
    control = {}
    for _, row in rows[:header]:
        matched = re.match(r'(收入|支出|中性交易)：(\d+)笔\s*([\d.]+)元', row.get('A', ''))
        if matched:
            control[{'收入': 'income', '支出': 'expense', '中性交易': 'transfer'}[matched[1]]] = {
                'count': int(matched[2]), 'cents': int(Decimal(matched[3]) * 100)}
    entries = []
    for number, row in rows[header + 1:]:
        if not row.get('I'):
            continue
        raw = row['A']
        day = (datetime(1899, 12, 30) + timedelta(days=float(raw))).strftime('%Y-%m-%d') if re.fullmatch(r'\d+(\.\d+)?', raw) else raw[:10]
        kind = {'收入': 'income', '支出': 'expense', '/': 'transfer'}.get(row.get('E'))
        if kind == 'income' and '退款' in row.get('B', ''):
            kind = 'refund'
        if kind is None:
            fail('未知收支方向')
        amount = money(row['F'])
        category = '退款' if kind == 'refund' else '账户划转' if kind == 'transfer' else '未分类'
        entries.append({'row': number, 'externalId': row['I'], 'day': day, 'kind': kind, 'amount': str(amount),
                        'category': category, 'counterparty': row.get('C', ''), 'description': row.get('D', ''),
                        'account': row.get('G', ''), 'status': row.get('H', '')})
    return {'format': 'wechat-xlsx', 'digest': sha256(path), 'label': path.name, 'rows': entries, 'control': control}


def decode_alipay(raw):
    if raw[:2] in (b'\xff\xfe', b'\xfe\xff'):
        return raw.decode('utf-16')
    for encoding in ('utf-8-sig', 'gb18030'):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    fail('无法识别支付宝账单编码')


def parse_alipay(path):
    text = decode_alipay(path.read_bytes())
    lines = text.splitlines()
    header_index = next((i for i, line in enumerate(lines) if line.strip().startswith('交易时间')), None)
    if header_index is None:
        fail('不是支持的支付宝交易明细')
    header = [name.strip() for name in next(csv.reader([lines[header_index]]))]
    missing = [name for name in ALIPAY_REQUIRED if name not in header]
    if missing:
        fail('支付宝账单缺少列：' + '、'.join(missing))
    total = None
    footer = {}
    for line in lines[:header_index]:
        matched = re.fullmatch(r'共\s*(\d+)\s*笔记录', line.strip())
        if matched:
            total = int(matched[1])
        matched = re.fullmatch(r'(收入|支出|不计收支)：(\d+)笔\s*([\d.]+)元', line.strip())
        if matched:
            footer[{'收入': 'income', '支出': 'expense', '不计收支': 'transfer'}[matched[1]]] = {
                'count': int(matched[2]), 'cents': int(Decimal(matched[3]) * 100)}
    entries, skipped = [], []
    reader = csv.reader(io.StringIO('\n'.join(lines[header_index + 1:])))
    for offset, values in enumerate(reader):
        if not any(value.strip() for value in values):
            continue
        number = header_index + offset + 2
        if len(values) != len(header):
            fail('第%d行列数异常，请用支付宝原始导出文件' % number)
        row = dict(zip(header, values))
        external_id = row['交易订单号'].strip().strip('\t')
        if not external_id:
            fail('第%d行缺少交易订单号' % number)
        if len(external_id) > 200:
            fail('第%d行交易订单号过长' % number)
        day = day_of(row['交易时间'])
        amount = money(row['金额'])
        direction, status = row['收/支'].strip(), row['交易状态'].strip()
        if status not in ALIPAY_SUCCESS:
            skipped.append({'row': number, 'day': day, 'status': status, 'direction': direction,
                            'amount': str(amount), 'category': row['交易分类'].strip()})
            continue
        if direction == '支出':
            kind = 'expense'
        elif direction == '收入':
            kind = 'income'
        elif direction == '不计收支':
            kind = 'refund' if status == '退款成功' else 'transfer'
        else:
            fail('第%d行收支方向未知：%s' % (number, direction))
        if kind in ('expense', 'income') and row['交易分类'].strip() == '账户存取':
            kind = 'transfer'
        category = '退款' if kind == 'refund' else '账户划转' if kind == 'transfer' else '未分类'
        entries.append({'row': number, 'externalId': external_id, 'day': day, 'kind': kind, 'amount': str(amount),
                        'category': category, 'counterparty': row['交易对方'].strip(),
                        'description': row['商品说明'].strip(), 'account': row['收/付款方式'].strip(),
                        'status': status})
    if not entries:
        fail('支付宝账单没有可入账的成功交易')
    if total is not None and total != len(entries) + len(skipped):
        fail('明细共%d笔，与页头共%d笔记录不一致' % (len(entries) + len(skipped), total))
    settled = {}
    for entry in entries:
        bucket = 'income' if entry['kind'] in ('income', 'refund') else entry['kind']
        settled.setdefault(bucket, {'count': 0, 'cents': 0})
        settled[bucket]['count'] += 1
        settled[bucket]['cents'] += int(Decimal(entry['amount']) * 100)
    skipped_cents = sum(int(Decimal(item['amount']) * 100) for item in skipped)
    control = {'total': total if total is not None else len(entries) + len(skipped),
               'settled': settled, 'footer': footer,
               'skipped': {'count': len(skipped), 'cents': skipped_cents, 'rows': skipped}}
    return {'format': 'alipay-csv', 'digest': sha256(path), 'label': path.name, 'rows': entries, 'control': control}


def parse(path):
    p = Path(path)
    if not p.is_file():
        fail('账单文件不存在')
    verify_size(p)
    if p.suffix.lower() == '.csv':
        return parse_alipay(p)
    if p.suffix.lower() == '.xlsx':
        return parse_wechat(p)
    fail('只支持微信支付 XLSX 或支付宝 CSV 账单')


if __name__ == '__main__':
    print(json.dumps(parse(sys.argv[1]), ensure_ascii=False))
