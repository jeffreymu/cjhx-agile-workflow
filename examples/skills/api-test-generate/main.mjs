let input = "";
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input);
const method = String(payload.operation?.method ?? "GET").toUpperCase();
const path = String(payload.operation?.path ?? "/");
const cases = [
  { name: "正常请求", method, path, expectedStatus: "2xx" },
  { name: "未授权请求", method, path, auth: null, expectedStatus: 401 },
  { name: "非法输入", method, path, input: "invalid", expectedStatus: "4xx" }
];
process.stdout.write(JSON.stringify({ output: { cases }, evidence: [], operations: [] }));
