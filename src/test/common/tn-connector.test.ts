/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

import * as tap from "tap";

import { TnConnector } from "../../common/tn-connector";
import { initTestContext, testTnConnectorOptions } from "../test-context";

initTestContext(tap);

tap.test("TnConnector", async t => {
    const originalOptions = testTnConnectorOptions(t);
    const tnc = await TnConnector.start(originalOptions);

    await t.test("check TNC options", async ts => {
        ts.ok(tnc instanceof TnConnector);
        ts.strictSame(tnc.options, {
            coatyUsername: "",
            coatyPassword: "",
            coatyTlsCert: "",
            coatyTlsKey: "",
            coatyVerifyServerCert: "true",
            coatyFailFastIfOffline: "true",
            ...originalOptions,
        });
        ts.equal(tnc.debug.namespace, originalOptions.debug.namespace + ":TnConnector");
        ts.equal(tnc.coatyAgent.identity.name, originalOptions.coatyAgentIdentityName);
        ts.equal(tnc.coatyAgent.identity.objectId, originalOptions.coatyAgentIdentityId);
        ts.equal(tnc.coatyAgent.identity["role"], TnConnector.IDENTITY_ROLE);
        ts.strictSame(tnc.coatyAgent.runtime.commonOptions.extra, tnc.options);
    });

    await t.test("restart TNC communication with new namespace and identity", async ts => {
        const oldOptions = { ...tnc.options };
        await tnc.restartCoatyCommunication({
            coatyAgentIdentityName: oldOptions.coatyAgentIdentityName + "NEW",
            coatyAgentIdentityId: oldOptions.coatyAgentIdentityId + "NEW",
            coatyNamespace: oldOptions.coatyNamespace + "NEW",
        });
        ts.strictSame(tnc.options, {
            ...oldOptions,
            coatyAgentIdentityName: oldOptions.coatyAgentIdentityName + "NEW",
            coatyAgentIdentityId: oldOptions.coatyAgentIdentityId + "NEW",
            coatyNamespace: oldOptions.coatyNamespace + "NEW",
        });
        ts.equal(tnc.coatyAgent.identity.name, oldOptions.coatyAgentIdentityName + "NEW");
        ts.equal(tnc.coatyAgent.identity.objectId, oldOptions.coatyAgentIdentityId + "NEW");
    });

    await t.test("restart TNC communication with original namespace and identity", async ts => {
        const oldOptions = { ...tnc.options };
        await tnc.restartCoatyCommunication({
            coatyAgentIdentityName: originalOptions.coatyAgentIdentityName,
            coatyAgentIdentityId: originalOptions.coatyAgentIdentityId,
            coatyNamespace: originalOptions.coatyNamespace,
        });
        ts.strictSame(tnc.options, {
            ...oldOptions,
            coatyAgentIdentityName: originalOptions.coatyAgentIdentityName,
            coatyAgentIdentityId: originalOptions.coatyAgentIdentityId,
            coatyNamespace: originalOptions.coatyNamespace,
        });
        ts.equal(tnc.coatyAgent.identity.name, originalOptions.coatyAgentIdentityName);
        ts.equal(tnc.coatyAgent.identity.objectId, originalOptions.coatyAgentIdentityId);
    });

    // This should always be the final test for any started TnConnector instance.
    await t.test("stop TNC", async ts => {
        await tnc.stop();
        ts.equal(tnc.coatyAgent, undefined);
    });
});
