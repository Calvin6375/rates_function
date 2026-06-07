/**
 * @fileoverview Circle webhook signature verification — delegates to circleRailAdapter.
 */

const circleRailAdapter = require("./circleRailAdapter");

/**
 * @param {import("express").Request} req
 * @param {Buffer|string} rawBody
 * @returns {Promise<boolean>}
 */
async function verifyCircleSignature(req, rawBody) {
  return circleRailAdapter.verifyWebhookSignature(req, rawBody);
}

module.exports = {
  verifyCircleSignature,
};
