#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";

const upstream = "https://www.renoise.ai";
const port = Number(process.env.PORT || 8789);
const proxyToken = process.env.TOMATO_RENOISE_PROXY_TOKEN || "";
const run = promisify(execFile);

function isPrivateIp(hostname) {
  const version = net.isIP(hostname);
  if (!version) return false;
  if (version === 6) return hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80");
  const [a, b] = hostname.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function assertSafeVideoUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw new Error("videoUrl must be https");
  if (["localhost", "localhost.localdomain"].includes(parsed.hostname) || isPrivateIp(parsed.hostname)) {
    throw new Error("videoUrl host is not allowed");
  }
  return parsed;
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function extractTailFrame(videoUrl) {
  if (!ffmpegPath) throw new Error("ffmpeg-static is unavailable");
  const parsed = assertSafeVideoUrl(videoUrl);
  const response = await fetch(parsed, { redirect: "follow" });
  if (!response.ok) throw new Error(`video download failed (${response.status})`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > 100 * 1024 * 1024) throw new Error("video is too large");

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "tomato-tail-"));
  const inputPath = path.join(workDir, "input.mp4");
  const outputPath = path.join(workDir, "tail.jpg");
  try {
    await fs.writeFile(inputPath, Buffer.from(await response.arrayBuffer()));
    await run(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-sseof",
      "-1",
      "-i",
      inputPath,
      "-an",
      "-update",
      "1",
      "-q:v",
      "2",
      "-y",
      outputPath,
    ], { timeout: 30000 });
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      res.writeHead(400);
      res.end("missing url");
      return;
    }

    if (proxyToken && req.headers["x-tomato-proxy-token"] !== proxyToken) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }

    const requestUrl = new URL(req.url, "http://127.0.0.1");
    if (requestUrl.pathname === "/tomato/tail-frame" && req.method === "POST") {
      const body = await readRequestJson(req);
      const frame = await extractTailFrame(body.videoUrl);
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "no-store",
      });
      res.end(frame);
      return;
    }

    const target = new URL(req.url, upstream);
    if (!target.pathname.startsWith("/api/public/v1/")) {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (!value || key.toLowerCase() === "host" || key.toLowerCase() === "content-length") continue;
      headers.set(key, Array.isArray(value) ? value.join(",") : value);
    }
    headers.delete("x-tomato-proxy-token");
    headers.set("Accept", headers.get("Accept") || "application/json");
    headers.set("User-Agent", "renoise-cli/0.7.0 tomato-live-proxy");

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const upstreamResponse = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
    });

    const responseHeaders = {};
    upstreamResponse.headers.forEach((value, key) => {
      if (!["content-encoding", "content-length", "transfer-encoding"].includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });
    res.writeHead(upstreamResponse.status, responseHeaders);
    res.end(Buffer.from(await upstreamResponse.arrayBuffer()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "proxy error";
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`tomato Renoise proxy listening on http://127.0.0.1:${port}`);
});
