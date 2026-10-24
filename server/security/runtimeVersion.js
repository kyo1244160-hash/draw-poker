'use strict';

const { satisfies } = require('next/dist/compiled/semver');
const { engines } = require('../../package.json');

function isSupportedNode(version = process.versions.node) {
  return satisfies(version, engines.node);
}

function assertSupportedNode() {
  if (!isSupportedNode()) {
    throw new Error(`Unsupported Node.js ${process.version}; required: ${engines.node}. Check NODE_VERSION.`);
  }
}

module.exports = { isSupportedNode, assertSupportedNode };
