#!/usr/bin/env node
import http from "node:http";
import net from "node:net";
import { once } from "node:events";

const listenHost = process.env.LISTEN_HOST || "127.0.0.1";
const listenPort = Number(process.env.LISTEN_PORT || "10809");
const socksHost = process.env.SOCKS_HOST || "127.0.0.1";
const socksPort = Number(process.env.SOCKS_PORT || "10808");
const connectTimeoutMs = Number(process.env.CONNECT_TIMEOUT_MS || "20000");

function parseHostPort(value, defaultPort) {
  if (!value) {
    throw new Error("empty CONNECT target");
  }

  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) {
      throw new Error(`invalid IPv6 CONNECT target: ${value}`);
    }
    const host = value.slice(1, end);
    const portText = value.slice(end + 1).replace(/^:/, "");
    return [host, Number(portText || defaultPort)];
  }

  const idx = value.lastIndexOf(":");
  if (idx === -1) {
    return [value, defaultPort];
  }
  return [value.slice(0, idx), Number(value.slice(idx + 1) || defaultPort)];
}

function createReader(socket) {
  let buffered = Buffer.alloc(0);
  const reads = [];

  const drain = () => {
    while (reads.length > 0 && buffered.length >= reads[0].size) {
      const read = reads.shift();
      const chunk = buffered.subarray(0, read.size);
      buffered = buffered.subarray(read.size);
      read.resolve(chunk);
    }
  };

  const onData = (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    drain();
  };

  const onError = (error) => {
    while (reads.length > 0) {
      reads.shift().reject(error);
    }
  };

  const onClose = () => {
    while (reads.length > 0) {
      reads.shift().reject(new Error("socket closed during SOCKS handshake"));
    }
  };

  socket.on("data", onData);
  socket.once("error", onError);
  socket.once("close", onClose);

  return {
    read(size) {
      if (buffered.length >= size) {
        const chunk = buffered.subarray(0, size);
        buffered = buffered.subarray(size);
        return Promise.resolve(chunk);
      }
      return new Promise((resolve, reject) => {
        reads.push({ size, resolve, reject });
      });
    },
    dispose() {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    },
  };
}

async function connectViaSocks(targetHost, targetPort) {
  const socket = net.connect({ host: socksHost, port: socksPort });
  socket.setTimeout(connectTimeoutMs, () => {
    socket.destroy(new Error("SOCKS connection timed out"));
  });

  await Promise.race([
    once(socket, "connect"),
    once(socket, "error").then(([error]) => Promise.reject(error)),
  ]);

  const reader = createReader(socket);
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  const method = await reader.read(2);
  if (method[0] !== 0x05 || method[1] !== 0x00) {
    throw new Error(`SOCKS server rejected no-auth method: ${method.toString("hex")}`);
  }

  const port = Buffer.alloc(2);
  port.writeUInt16BE(targetPort, 0);

  let atyp;
  let address;
  const ipType = net.isIP(targetHost);
  if (ipType === 4) {
    atyp = 0x01;
    address = Buffer.from(targetHost.split(".").map((part) => Number(part)));
  } else {
    atyp = 0x03;
    const domain = Buffer.from(targetHost);
    if (domain.length > 255) {
      throw new Error(`target host is too long: ${targetHost}`);
    }
    address = Buffer.concat([Buffer.from([domain.length]), domain]);
  }

  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, atyp]), address, port]));
  const reply = await reader.read(4);
  if (reply[0] !== 0x05 || reply[1] !== 0x00) {
    throw new Error(`SOCKS CONNECT failed with code ${reply[1]}`);
  }

  if (reply[3] === 0x01) {
    await reader.read(6);
  } else if (reply[3] === 0x03) {
    const length = await reader.read(1);
    await reader.read(length[0] + 2);
  } else if (reply[3] === 0x04) {
    await reader.read(18);
  } else {
    throw new Error(`unsupported SOCKS address type: ${reply[3]}`);
  }

  reader.dispose();
  socket.setTimeout(0);
  return socket;
}

function destroyQuietly(socket) {
  if (!socket || socket.destroyed) {
    return;
  }
  socket.destroy();
}

const server = http.createServer((req, res) => {
  res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
  res.end("Only HTTP CONNECT is supported.\n");
});

server.on("connect", async (req, clientSocket, head) => {
  let upstream;
  clientSocket.on("error", () => {
    destroyQuietly(upstream);
  });
  clientSocket.on("close", () => {
    destroyQuietly(upstream);
  });
  try {
    const [targetHost, targetPort] = parseHostPort(req.url, 443);
    upstream = await connectViaSocks(targetHost, targetPort);
    upstream.on("error", () => {
      destroyQuietly(clientSocket);
    });
    upstream.on("close", () => {
      destroyQuietly(clientSocket);
    });
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) {
      upstream.write(head);
    }
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  } catch (error) {
    console.error(`[proxy] CONNECT ${req.url || ""} failed:`, error.message);
    if (!clientSocket.destroyed) {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    }
    clientSocket.destroy();
    upstream?.destroy();
  }
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(listenPort, listenHost, () => {
  console.log(
    `[proxy] HTTP CONNECT ${listenHost}:${listenPort} -> SOCKS ${socksHost}:${socksPort}`,
  );
});
