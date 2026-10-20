"""Backward-compatible entry point. Bill parsing lives in bill.py and supports WeChat XLSX and
Alipay CSV; keep this wrapper for older operator scripts that still call wechat-bill.py."""
import sys, json
from bill import parse

if __name__ == '__main__':
    print(json.dumps(parse(sys.argv[1]), ensure_ascii=False))
