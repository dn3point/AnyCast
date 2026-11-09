'use strict';
const { createGateway } = require('../src/server');
const log = require('../src/util/log');

log.setLevel(process.env.ANYCAST_LOG || 'warn');

async function startGateway(opts = {}) {
  const gw = createGateway({ port: 0, discovery: false, advertiseHost: '127.0.0.1', ...opts });
  await gw.listen('127.0.0.1');
  const base = `http://127.0.0.1:${gw.port}`;
  const api = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    return { status: res.status, body: json };
  };
  return { gw, base, api };
}

module.exports = { startGateway };
