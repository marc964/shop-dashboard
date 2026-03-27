#!/usr/bin/env node
/**
 * Update snapshot hashes from current checkout.json.
 * No dependencies beyond Node built-ins.
 */

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const OWNERS = [
  "Barton", "Berke", "Miner", "Preheim",
  "Connolly", "Witham", "Ferdman", "McDonough",
];

const DATA_DIR = path.join(__dirname, "..", "data");
const HASHES_FILE = path.join(DATA_DIR, "snapshot-hashes.json");

function hashVehicle(vehicle) {
  const relevant = {
    checkout: vehicle.checkout,
    status: vehicle.status,
    punchlist: vehicle.punchlist,
  };
  return crypto
    .createHash("md5")
    .update(JSON.stringify(relevant))
    .digest("hex");
}

const checkoutData = JSON.parse(
  fs.readFileSync(path.join(DATA_DIR, "checkout.json"), "utf8")
);

const vehiclesByOwner = {};
for (const v of checkoutData.vehicles) {
  vehiclesByOwner[v.owner] = v;
}

const hashes = {};
for (const owner of OWNERS) {
  const v = vehiclesByOwner[owner];
  if (v) {
    hashes[owner] = hashVehicle(v);
  }
}

fs.writeFileSync(HASHES_FILE, JSON.stringify(hashes, null, 2) + "\n");
console.log(`Updated hashes for ${Object.keys(hashes).length} vehicles.`);
