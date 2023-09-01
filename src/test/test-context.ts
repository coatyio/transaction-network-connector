/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

import { Runtime } from "@coaty/core";
import Debug from "debug";
import * as os from "os";
import * as path from "path";
import * as tp from "tap";
import * as util from "util";

import { TnConnectorOptions } from "../common/tn-connector";

/**
 * Regexp describing a valid UUID v4 string.
 */
export const UUID_REGEX = /[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89aAbB][a-f0-9]{3}-[a-f0-9]{12}/;

/**
 * Initialize the toplevel tap test context.
 *
 * This function must be invoked in any test file *before* executing tests.
 *
 * @param tap a root-level Tap object as imported from "tap"
 */
export function initTestContext(tap: typeof tp) {
    const testContextFile = path.join(os.tmpdir(), "flowpro-tnc-test-context.json");
    const testContext = require(testContextFile);

    Object.assign(tap.context, testContext);

    // Note: tap won't run with TSCONFIG esModuleInterop option enabled, throws
    // an error "beforeEach is not a function".

    // Ensure test context is propagated to all child tests.
    tap.beforeEach(t => {
        Object.assign(t.context, testContext);

        // Provide ordered execution of teardown functions and a teardown check.
        const teardownFuncs: Array<() => void | Promise<void>> = [];
        t.context.addTeardown = (fn: () => void | Promise<void>, position: "start" | "end" = "start") => {
            if (position === "start") {
                teardownFuncs.unshift(fn);
            } else {
                teardownFuncs.push(fn);
            }
        };
        let isTearingdown = false;
        t.context.isTearingdown = () => isTearingdown;
        t.teardown(async () => {
            isTearingdown = true;
            for (const func of teardownFuncs) {
                await func();
            }
        });
    });
}

/**
 * Gets TnConnector options for testing.
 *
 * @param test a tap Test object
 * @param agentIndex index of TNC agent to be started (default 0)
 * @returns TnConnector specific options for the given test
 */
export function testTnConnectorOptions(
    test: typeof tp.Test.prototype,
    agentIndex = 0,
    agentNamePrefix = "FlowPro Test Agent",
): TnConnectorOptions {
    return {
        coatyAgentIdentityName: `${agentNamePrefix} ${process.env.TAP_CHILD_ID}#${agentIndex}`,
        coatyAgentIdentityId: Runtime.newUuid(),
        coatyBrokerUrl: (test.context.brokerUrls as string[]).find(u => u.startsWith("mqtt:")),

        // Support parallel test execution with isolated broker communication.
        coatyNamespace: `tnc.test${process.env.TAP_CHILD_ID}`,
        coatyFailFastIfOffline: "true",

        grpcProtoPath: "./dist/proto",
        grpcServerPort: (5010 + agentIndex).toString(),

        debug: Debug("tnc"),

        consensusDatabaseFolder: os.tmpdir(),
    };
}

/**
 * Redirect output of a console logging function to a string array.
 *
 * @param mode the type of console to redirect
 * @param callback a function invoked whenever a new output string has been
 * generated; call the `done` function to stop redirection (optional)
 * @returns a function that, when called, stops redirection and returns an array
 * of redirected output strings ordered by console function invocations.
 */
export function consoleRedirect(
    mode: "log" | "error" | "info" | "warn" | "debug",
    callback?: (output: string[], done: () => void) => void): () => string[] {
    const output: string[] = [];
    let consoleFunc = console[mode];
    const completer = () => {
        if (consoleFunc === undefined) {
            return;
        }
        console[mode] = consoleFunc;
        consoleFunc = undefined;
        return output;
    };

    console[mode] = (data: any, ...args: any[]) => {
        output.push(util.format(data, ...args));
        if (callback) {
            callback(output, completer);
        }
    };

    return completer;
}
