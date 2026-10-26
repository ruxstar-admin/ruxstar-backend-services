const http = require("node:http");

const port = Number(process.env.PORT) || 8080;

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;

  if (req.method === "GET" && path === "/health") {
    return send(res, 200, {
      data: { status: "ok", revision: process.env.K_REVISION || "local" },
    });
  }

  if (req.method === "GET" && path === "/") {
    return send(res, 200, { data: { name: "Ruxstar API", liveOn: "2026-11-30" } });
  }

  return send(res, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
});

server.listen(port, () => console.log(`Ruxstar API listening on ${port}`));

process.on("SIGTERM", () => server.close(() => process.exit(0)));
