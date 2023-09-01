/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

import Debug from "debug";
import { readFileSync, writeFileSync } from "fs";
import * as path from "path";

import { TnConnector, TnConnectorOptions } from "./common/tn-connector";

const debug = Debug("tnc");

// Use path.join with dirname to ensure pkg tool can access snapshotted package.json.
const pkg = JSON.parse(readFileSync(path.join(__dirname, "../package.json"), "utf-8"));

if (process.argv.length > 2 && (process.argv[2] === "-v" || process.argv[2] === "--version")) {
    console.log("v%s", pkg.version);
    process.exit();
}

if (process.argv.length > 2 && (process.argv[2] === "-a" || process.argv[2] === "--assets")) {
    // Note: Do not use copyFileSync as it cannot handle snapshot files in
    // packaged TNC executables.
    const iccProto = readFileSync(path.join(__dirname, "./proto/tnc_icc.proto"));
    const coatyProto = readFileSync(path.join(__dirname, "./proto/tnc_coaty.proto"));
    const lifeProto = readFileSync(path.join(__dirname, "./proto/tnc_life.proto"));
    const consensusProto = readFileSync(path.join(__dirname, "./proto/tnc_consensus.proto"));
    writeFileSync("tnc_icc.proto", iccProto);
    writeFileSync("tnc_coaty.proto", coatyProto);
    writeFileSync("tnc_life.proto", lifeProto);
    writeFileSync("tnc_consensus.proto", consensusProto);
    console.log("Extracted TNC Protobuf files to current working directory %s", process.cwd());
    process.exit();
}

const envVarPrefix = "FLOWPRO_TNC_";
const env2Option = (v: string) => v.toLowerCase().split("_").map((s, i) => i === 0 ? s : s[0].toUpperCase() + s.substring(1)).join("");
// const option2Env = (o: string) => envVarPrefix + o.split(/(?=[A-Z])/).join("_").toUpperCase();
const envVars = Object.keys(process.env).filter(k => k.startsWith(envVarPrefix)).map(k => k.substring(envVarPrefix.length)).sort();
const optionVars = envVars.reduce((p, c) => (p[env2Option(c)] = envVarPrefix + c, p), {} as { [key: string]: string });
const options = envVars.reduce((p, c) =>
    (process.env[envVarPrefix + c] ? p[env2Option(c)] = process.env[envVarPrefix + c] : delete p[env2Option(c)], p),
    {} as { [key: string]: any });

process.on("unhandledRejection", (error, p) => {
    debug("UnhandledPromiseRejection on %O", p);
    // Always exit in case of an unhandled promise rejection.
    process.exit(1);
});

debug("Release v%s, Package %s@%s", pkg.version, pkg.name, pkg.version);
if (Object.keys(optionVars).length === 0) {
    debug("No environment variables specified for TN Connector");
} else {
    Object.entries(optionVars).forEach(([k, v]) => debug("%s=%s", v, options[k]));
}

(async () => {
    try {
        await TnConnector.start({ debug, ...options } as TnConnectorOptions);
    } catch (error) {
        debug("Failed starting up TN Connector: %O", error);
        process.exit(1);
    }
})();
