'use strict';

const { isSupportedNode } = require('./runtimeVersion');

function getHealthStatus(env = process.env, version = process.versions.node) {
  const runtimeSupported = isSupportedNode(version);
  return {
    ok: runtimeSupported,
    status: runtimeSupported ? 'ok' : 'runtime_unsupported',
    service: 'Poker Room Pastis',
    revision: env.RENDER_GIT_COMMIT?.slice(0, 12) ?? null,
    runtimeSupported,
    uptime: Math.round(process.uptime()),
    ts: Date.now(),
  };
}

module.exports = { getHealthStatus };
