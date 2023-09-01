/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

import { CallOptions, ClientReadableStream, ServiceError, status as StatusCode } from "@grpc/grpc-js";
import * as tap from "tap";

import { TnConnector } from "../../common/tn-connector";
import { AgentLifecycleEvent, AgentLifecycleState, AgentSelector } from "../../service/tn-lifecycle-service";
import { initTestContext, testTnConnectorOptions } from "../test-context";
import { connectGrpcTestClient, GrpcTestClientWithPackage } from "../test-grpc";

/* Utility types and functions */

type AgentLifecycleStates = Array<[
    identity: [id: string, name: string],
    state: AgentLifecycleState,
    local: boolean,
    parallelWithNext?: boolean,
]>;

interface TnLifeClient extends GrpcTestClientWithPackage {
    trackAgents: (selector: AgentSelector, callOptions?: CallOptions) => ClientReadableStream<AgentLifecycleEvent>;
}

async function initTnLifeClient(test: typeof tap.Test.prototype, agentIndex: number): Promise<TnLifeClient> {
    const client = await connectGrpcTestClient<TnLifeClient>(test, "flowpro.tnc.life.LifecycleService", [], agentIndex);
    test.context.addTeardown(() => client.close(), "end");
    return client;
}

function tncIdentity(tnc: TnConnector): [id: string, name: string] {
    return [tnc.coatyAgent.identity.objectId, tnc.coatyAgent.identity.name];
}

function trackAgents(
    test: typeof tap.Test.prototype,
    client: TnLifeClient,
    agentSelector: AgentSelector,
    expectedStates: AgentLifecycleStates,
    deadlineAfter: number,
    shouldCallEndExpectedly?: boolean,
    expectTrackingFails?: StatusCode,
) {
    return new Promise<void>(resolve => {
        const call = client.trackAgents(agentSelector, { deadline: Date.now() + deadlineAfter });
        const stateCache = [...expectedStates];
        let isCallEndedExpectedly = false;
        test.context.addTeardown(() => call.cancel(), "start");
        call
            .on("data", (event: AgentLifecycleEvent) => {
                if (stateCache.length === 0) {
                    test.fail(`trackAgents got unexpected agent lifecycle event ${event.identity.name}@${event.identity.id}, state ${event.state}`);
                } else {
                    for (let i = 0; i < stateCache.length; i++) {
                        const item = stateCache[i];
                        if (event.identity.id === item[0][0] &&
                            event.identity.name === item[0][1] &&
                            event.state === item[1] &&
                            event.identity.local === item[2]) {
                            stateCache.splice(i, 1);
                            break;
                        } else if (!item[3]) {
                            test.fail(`trackAgents got unexpected agent lifecycle event ${event.identity.name}@${event.identity.id}, state ${event.state}`);
                            break;
                        } else {
                            continue;
                        }
                    }
                }
            })
            .once("end", () => {
                // Invoked on server call end or client call cancel/deadline exceeded.
                if (test.context.isTearingdown()) {
                    // Do not use test assertions here as test has already finished.
                    resolve();
                    return;
                }
                if (isCallEndedExpectedly) {
                    resolve();
                    return;
                }
                if (shouldCallEndExpectedly) {
                    test.equal(stateCache.length, 0);
                    test.pass("trackAgents should end expectedly by server");
                } else {
                    test.fail("trackAgents should not be ended unexpectedly by server");
                }
                resolve();
            })
            .once("error", (error: ServiceError) => {
                if (test.context.isTearingdown()) {
                    // Do not use test assertions here as test has already finished.
                    // Error listener is required to prevent tapUncaughtException.
                    return;
                }
                if (error.code === StatusCode.DEADLINE_EXCEEDED) {
                    test.equal(stateCache.length, 0);
                    isCallEndedExpectedly = true;
                } else if (error.code === StatusCode.INVALID_ARGUMENT) {
                    if (expectTrackingFails !== error.code) {
                        test.fail("trackAgents should not fail with error status INVALID_ARGUMENT");
                    } else {
                        test.pass("trackAgents should fail with error status INVALID_ARGUMENT");
                    }
                    isCallEndedExpectedly = true;
                } else if (error.code === StatusCode.UNAVAILABLE) {
                    if (expectTrackingFails !== error.code) {
                        test.fail("trackAgents should not fail with error status UNAVAILABLE");
                    } else {
                        test.pass("trackAgents should fail with error status UNAVAILABLE");
                    }
                    isCallEndedExpectedly = true;
                } else if (error.code === StatusCode.CANCELLED) {
                    if (expectTrackingFails !== error.code) {
                        test.fail("trackAgents should not fail with error status CANCELLED");
                    } else {
                        test.pass("trackAgents should fail with error status CANCELLED");
                    }
                    isCallEndedExpectedly = true;
                } else {
                    test.error(error);
                }
            });
    });
}

/* Tests */

initTestContext(tap);

// Do not timeout tests in this suite.
tap.setTimeout(0);

tap.test("LifecycleService", async t => {
    const tnc1 = await TnConnector.start(testTnConnectorOptions(t, 1, "FM agent"));
    const tnc2 = await TnConnector.start(testTnConnectorOptions(t, 2, "AGV agent"));
    const tnc3 = await TnConnector.start(testTnConnectorOptions(t, 3, "AGV agent"));
    const client1 = await initTnLifeClient(t, 1);
    const client2 = await initTnLifeClient(t, 2);
    const client3 = await initTnLifeClient(t, 3);

    await t.test("track agents yields INVALID_ARGUMENT error", async ts => {
        await trackAgents(ts,
            client1,
            { identityName: "/[/" },
            [],
            1000,
            false,
            StatusCode.INVALID_ARGUMENT,
        );
    });

    await t.test("track all agents initially", async ts => {
        const expectedStates = (client: TnLifeClient): AgentLifecycleStates => [
            [tncIdentity(tnc1), AgentLifecycleState.Join, client === client1, true],
            [tncIdentity(tnc2), AgentLifecycleState.Join, client === client2, true],
            [tncIdentity(tnc3), AgentLifecycleState.Join, client === client3, true],
        ];
        await Promise.allSettled([
            trackAgents(ts,
                client1,
                { identityName: "" },
                expectedStates(client1),
                1000,
            ),
            trackAgents(ts,
                client1,
                { identityId: "" },
                expectedStates(client1),
                1000,
            ),
            trackAgents(ts,
                client1,
                {},
                expectedStates(client1),
                1000,
            ),
            trackAgents(ts,
                client2,
                {},
                expectedStates(client2),
                1000,
            ),
            trackAgents(ts,
                client3,
                {},
                expectedStates(client3),
                1000,
            ),
        ]);
    });

    await t.test("track FM agent by identity name", async ts => {
        const expectedStates = (client: TnLifeClient): AgentLifecycleStates => [
            [tncIdentity(tnc1), AgentLifecycleState.Join, client === client1],
        ];
        await Promise.allSettled([
            trackAgents(ts,
                client1,
                { identityName: tnc1.coatyAgent.identity.name },
                expectedStates(client1),
                1000,
            ),
            trackAgents(ts,
                client2,
                { identityName: tnc1.coatyAgent.identity.name },
                expectedStates(client2),
                1000,
            ),
            trackAgents(ts,
                client3,
                { identityName: tnc1.coatyAgent.identity.name },
                expectedStates(client3),
                1000,
            ),
        ]);
    });

    await t.test("track FM agent by identity id", async ts => {
        const expectedStates = (client: TnLifeClient): AgentLifecycleStates => [
            [tncIdentity(tnc1), AgentLifecycleState.Join, client === client1],
        ];
        await Promise.allSettled([
            trackAgents(ts,
                client1,
                { identityId: tnc1.coatyAgent.identity.objectId },
                expectedStates(client1),
                1000,
            ),
            trackAgents(ts,
                client2,
                { identityId: tnc1.coatyAgent.identity.objectId },
                expectedStates(client2),
                1000,
            ),
            trackAgents(ts,
                client3,
                { identityId: tnc1.coatyAgent.identity.objectId },
                expectedStates(client3),
                1000,
            ),
        ]);
    });

    await t.test("track AGV agents only", async ts => {
        const expectedStates = (client: TnLifeClient): AgentLifecycleStates => [
            [tncIdentity(tnc2), AgentLifecycleState.Join, client === client2, true],
            [tncIdentity(tnc3), AgentLifecycleState.Join, client === client3, true],
        ];
        await Promise.allSettled([
            trackAgents(ts,
                client1,
                { identityName: "/^AGV agent.*$/" },
                expectedStates(client1),
                1000,
            ),
            trackAgents(ts,
                client2,
                { identityName: "/^AGV agent.*$/" },
                expectedStates(client2),
                1000,
            ),
            trackAgents(ts,
                client3,
                { identityName: "/^AGV agent.*$/" },
                expectedStates(client3),
                1000,
            ),
        ]);
    });

    await t.test("track FM agent restarting with new identity id", async ts => {
        const newTnc1Id = tnc1.coatyAgent.runtime.newUuid();
        const expectedStates = (client: TnLifeClient): AgentLifecycleStates => client === client1 ?
            [
                [tncIdentity(tnc1), AgentLifecycleState.Join, true],
            ] :
            [
                [tncIdentity(tnc1), AgentLifecycleState.Join, false],
                [tncIdentity(tnc1), AgentLifecycleState.Leave, false],
                [[newTnc1Id, tnc1.coatyAgent.identity.name], AgentLifecycleState.Join, false],
            ];
        const promises = [
            trackAgents(ts,
                client1,
                { identityName: tnc1.coatyAgent.identity.name },
                expectedStates(client1),
                2000,

                // Note that trackAgents streaming call will be ended by server
                // forcibly as soon as FM agent's communication manager is
                // stopped, so we won't receive its identity after being
                // restarted.
                true,
            ),
            trackAgents(ts,
                client2,
                { identityName: tnc1.coatyAgent.identity.name },
                expectedStates(client2),
                2000,
            ),
            trackAgents(ts,
                client3,
                { identityName: tnc1.coatyAgent.identity.name },
                expectedStates(client3),
                2000,
            ),
        ];
        await new Promise(res => setTimeout(res, 1000));
        await tnc1.restartCoatyCommunication({ coatyAgentIdentityId: newTnc1Id });
        await Promise.allSettled(promises);
    });

    await t.test("track FM agent restarting with new identity name", async ts => {
        const newTnc1Name = tnc1.coatyAgent.identity.name + "NEW";
        const expectedStates = (client: TnLifeClient): AgentLifecycleStates => client === client1 ?
            [
                [tncIdentity(tnc1), AgentLifecycleState.Join, true],
            ] :
            [
                [tncIdentity(tnc1), AgentLifecycleState.Join, false],
                [tncIdentity(tnc1), AgentLifecycleState.Leave, false],
                [[tnc1.coatyAgent.identity.objectId, newTnc1Name], AgentLifecycleState.Join, false],
            ];
        const promises = [
            trackAgents(ts,
                client1,
                { identityId: tnc1.coatyAgent.identity.objectId },
                expectedStates(client1),
                2000,

                // Note that trackAgents streaming call will be ended by server
                // forcibly as soon as FM agent's communication manager is
                // stopped, so we won't receive its identity after being
                // restarted.
                true,
            ),
            trackAgents(ts,
                client2,
                { identityId: tnc1.coatyAgent.identity.objectId },
                expectedStates(client2),
                2000,
            ),
            trackAgents(ts,
                client3,
                { identityId: tnc1.coatyAgent.identity.objectId },
                expectedStates(client3),
                2000,
            ),
        ];
        await new Promise(res => setTimeout(res, 1000));
        await tnc1.restartCoatyCommunication({ coatyAgentIdentityName: newTnc1Name });
        await Promise.allSettled(promises);
    });

    await t.test("track AGV agent 2 on stopping", async ts => {
        const expectedStates = (client: TnLifeClient): AgentLifecycleStates => client === client2 ?
            [
                [tncIdentity(tnc2), AgentLifecycleState.Join, true],
            ] :
            [
                [tncIdentity(tnc2), AgentLifecycleState.Join, false],
                [tncIdentity(tnc2), AgentLifecycleState.Leave, false],
            ];
        const promises = [
            trackAgents(ts,
                client1,
                { identityId: tnc2.coatyAgent.identity.objectId },
                expectedStates(client1),
                2000,
            ),
            trackAgents(ts,
                client2,
                { identityId: tnc2.coatyAgent.identity.objectId },
                expectedStates(client2),
                2000,

                // Note that trackAgents streaming call will be ended by TNC as
                // soon as AGV agent's communication manager is stopped, so we
                // won't receive its identity after being restarted.
                true,
                StatusCode.CANCELLED,
            ),
            trackAgents(ts,
                client3,
                { identityId: tnc2.coatyAgent.identity.objectId },
                expectedStates(client3),
                2000,
            ),
        ];
        await new Promise(res => setTimeout(res, 1000));
        await tnc2.stop(false);     // Stop TNC 2 immediately.
        await Promise.allSettled(promises);
    });

    // This should always be the final test for any started TnConnector instance.
    await t.test("stop TNCs", async ts => {
        ts.teardown(() => tnc1.stop());
        ts.teardown(() => tnc2.stop());
        ts.teardown(() => tnc3.stop());
    });
});
