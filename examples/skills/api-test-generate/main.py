#!/usr/bin/env python3
import json
import sys

payload = json.load(sys.stdin)
operation = payload.get("operation", {})
method = str(operation.get("method", "GET")).upper()
path = str(operation.get("path", "/"))
cases = [
    {"name": "正常请求", "method": method, "path": path, "expectedStatus": "2xx"},
    {"name": "未授权请求", "method": method, "path": path, "auth": None, "expectedStatus": 401},
    {"name": "非法输入", "method": method, "path": path, "input": "invalid", "expectedStatus": "4xx"}
]
json.dump({"output": {"cases": cases}, "evidence": [], "operations": []}, sys.stdout, ensure_ascii=False)
