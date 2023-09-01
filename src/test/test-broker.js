/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

const { fork } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const mqtt = require("mqtt");

const testContextFile = path.join(os.tmpdir(), "flowpro-tnc-test-context.json");

function startBroker() {
    return new Promise(resolve => {
        const brokerPort = 1888;
        const brokerUrls = [
            `mqtt://127.0.0.1:${brokerPort}`,
            `ws://127.0.0.1:${brokerPort + 8000}`,
        ];
        const child = fork("./node_modules/@coaty/core/scripts/coaty-scripts.js", ["broker",
            "--port", `${brokerPort}`,
            "--nobonjour",
            // "--verbose",
        ], {
            cwd: process.cwd(),
            detached: true,
            windowsHide: true,
            stdio: "ignore",
        });

        fs.writeFileSync(testContextFile, JSON.stringify({
            brokerPid: child.pid,
            shouldTerminateBroker: true,
            canStopAndRestartBrokerWhileTesting: true,
            // @todo update as soon as aedes broker supports MQTT 5.0
            supportsMqtt5: false,
            brokerUrls,
        }));

        child.connected && child.disconnect();
        child.unref();

        awaitBrokerStarted(brokerUrls, resolve);
    });
}

function awaitBrokerStarted(brokerUrls, resolve) {
    // Await broker up and accepting connections.
    const client = mqtt.connect(brokerUrls[0]);
    client.once("connect", () => {
        client.end(true, () => {
            // Defer removal of event listeners to ensure proper clean up.
            setTimeout(() => client.removeAllListeners(), 0);
            resolve(brokerUrls);
        });
    });
}

async function stopBroker() {
    let options;
    try {
        options = JSON.parse(fs.readFileSync(testContextFile).toString());
        if (options.shouldTerminateBroker) {
            process.kill(options.brokerPid);
        }
    } catch { }
    try {
        fs.unlinkSync(testContextFile);
    } catch { }
    return options === undefined ? false : options.shouldTerminateBroker;
}

module.exports = {
    startBroker,
    stopBroker,
};
