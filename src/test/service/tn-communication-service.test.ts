/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

import { Runtime } from "@coaty/core";
import { CallOptions, ClientReadableStream, ClientUnaryCall, sendUnaryData, ServiceError, status as StatusCode } from "@grpc/grpc-js";
import * as tap from "tap";

import { TnConnector, TnConnectorOptions } from "../../common/tn-connector";
import {
    CallEvent as PbCallEvent,
    CallSelector as PbCallSelector,
    ChannelEvent as PbChannelEvent,
    ChannelSelector as PbChannelSelector,
    CoatyCommunicationOptions,
    CompleteEvent as PbCompleteEvent,
    EventAck,
    ReturnEvent as PbReturnEvent,
} from "../../service/tn-communication-service";
import { initTestContext, testTnConnectorOptions, UUID_REGEX } from "../test-context";
import { connectGrpcTestClient, GrpcTestClientWithPackage } from "../test-grpc";

/* Utility types and functions */

type CallReturnCancellation = (cancelDelay?: number) => Promise<void>;

interface TnComClient extends GrpcTestClientWithPackage {
    sourceId: string;
    configure: (opts: CoatyCommunicationOptions, cb: sendUnaryData<EventAck>) => ClientUnaryCall;
    publishChannel: (event: PbChannelEvent, cb: sendUnaryData<EventAck>) => ClientUnaryCall;
    observeChannel: (selector: PbChannelSelector, callOptions?: CallOptions) => ClientReadableStream<PbChannelEvent>;
    publishCall: (event: PbCallEvent, callOptions?: CallOptions) => ClientReadableStream<PbReturnEvent>;
    observeCall: (selector: PbCallSelector, callOptions?: CallOptions) => ClientReadableStream<PbCallEvent>;
    publishReturn: (event: PbReturnEvent, cb: sendUnaryData<EventAck>) => ClientUnaryCall;
    publishComplete: (event: PbCompleteEvent, cb: sendUnaryData<EventAck>) => ClientUnaryCall;
}

interface TestOperationParams {
    responseCount: number;
    responseDelay: number;
}

interface TestOperationResult {
    value: number;
}

interface TestOperationExecutionInfo {
    responseIndex: number;
}

enum TestOperationId {
    Default = "flowpro.tnc.test.TestOperation",
    Empty = "",
    InvalidChars = "#+/",
}

enum TestChannelId {
    Push = "flowpro.tnc.test.Push",
    Empty = "",
    InvalidChars = "#+/",
}

async function initTnComClient(test: typeof tap.Test.prototype): Promise<TnComClient> {
    const client = await connectGrpcTestClient<TnComClient>(test, "flowpro.tnc.coaty.CommunicationService", ["tnc_test.proto"]);
    client.sourceId = Runtime.newUuid();
    test.context.addTeardown(() => client.close(), "end");
    return client;
}

function tnComTest(
    expectedTotalRoutingCount: number,
    testFunc: (test: typeof tap.Test.prototype) => void) {
    return (test: typeof tap.Test.prototype) => new Promise<void>(resolve => {
        let totalRoutingCount = 0;
        let isTestResolved = false;
        test.context.incrementTotalRoutingCount = (routingCount: number) => {
            totalRoutingCount += routingCount;
            if (isTestResolved) {
                test.fail(`should not be invoked after ending test`);
                return;
            }
            if (totalRoutingCount < expectedTotalRoutingCount) {
                test.pass(`totalRoutingCount (${totalRoutingCount}) still less than expectedTotalRoutingCount (${expectedTotalRoutingCount})`);
            } else if (totalRoutingCount === expectedTotalRoutingCount) {
                test.pass(`totalRoutingCount (${totalRoutingCount}) equals expectedTotalRoutingCount (${expectedTotalRoutingCount})`);
                isTestResolved = true;
                resolve();
            } else {
                // Fail fast as soon as expected total routing count is exceeded.
                test.fail(`totalRoutingCount (${totalRoutingCount}) should not exceed expectedTotalRoutingCount (${expectedTotalRoutingCount})`);
                isTestResolved = true;
                resolve();
            }
        };
        testFunc(test);
    });
}

function configureComOptions(
    test: typeof tap.Test.prototype,
    tnc: TnConnector,
    client: TnComClient,
    comOptions: CoatyCommunicationOptions,
    expectedTncOptions: Readonly<Partial<TnConnectorOptions>>,
) {
    return new Promise<void>(resolve => {
        const call = client.configure(comOptions, (error, response) => {
            if (error) {
                test.fail(error.details);
                resolve();
                return;
            }
            test.strictSame(response, {});
            Object.keys(expectedTncOptions).forEach(key => test.equal(tnc.options[key], expectedTncOptions[key]));
            if (tnc.options.coatyFailFastIfOffline === "true") {
                // Give Coaty agent time to reconnect before executing subsequent tests.
                setTimeout(resolve, 400);
            } else {
                resolve();
            }
        });
        test.context.addTeardown(() => call.cancel(), "start");
    });
}

function getChannelDataForSequenceId(seqId: number) {
    return { seqId, value: seqId + 10 };
}

function publishOnChannel(
    test: typeof tap.Test.prototype,
    client: TnComClient,
    channelId: string,
    channelData: any,
    waitTimeBeforeResolve?: number,
    expectPublicationFails?: StatusCode) {
    return new Promise<void>(resolve => {
        const call = client.publishChannel(
            {
                id: channelId,
                data: client.pkg.pack(channelData, "flowpro.tnc.test.PushData"),
                sourceId: client.sourceId,
            },
            (error, response) => {
                if (error) {
                    if (expectPublicationFails !== undefined) {
                        if (error.code === expectPublicationFails) {
                            test.pass(`publishChannel should fail with error status code ${StatusCode[error.code]} (${error.code})`);
                        } else {
                            test.fail(`publishChannel should not fail with unexpected error status code ${StatusCode[error.code]} (${error.code})`);
                        }
                    } else {
                        test.error(error);
                    }
                } else {
                    test.strictSame(response, {});
                    test.context.incrementTotalRoutingCount(0.5);
                }

                if (waitTimeBeforeResolve) {
                    setTimeout(resolve, waitTimeBeforeResolve);
                } else {
                    resolve();
                }
            });
        test.context.addTeardown(() => call.cancel(), "start");
    });
}

function observeChannel(
    test: typeof tap.Test.prototype,
    client: TnComClient,
    testSelector: PbChannelSelector,
    expectObservationFails?: StatusCode,
    deadlineAfter?: number,
    unexpectedChannelData?: { [key: string]: any },
    shouldObservationEndExpectedly?: boolean) {
    const call = client.observeChannel(testSelector, deadlineAfter ? { deadline: Date.now() + deadlineAfter } : undefined);
    let isCallEndedExpectedly = false;
    let channelSeqId = 0;
    test.context.addTeardown(() => call.cancel(), "start");
    call
        .on("data", (event: PbChannelEvent) => {
            test.equal(event.id, testSelector.id);
            test.ok(typeof event.sourceId === "string" && UUID_REGEX.test(event.sourceId));
            const data = client.pkg.unpack(event.data, "flowpro.tnc.test.PushData");
            if (unexpectedChannelData) {
                test.strictSame(data, unexpectedChannelData);
            } else {
                test.strictSame(data, getChannelDataForSequenceId(++channelSeqId));
            }
            test.context.incrementTotalRoutingCount(0.5);
        })
        .once("end", () => {
            // Invoked on server call end or client call cancel/deadline exceeded.
            if (test.context.isTearingdown()) {
                // Do not use test assertions here as test has already finished.
                return;
            }
            if (isCallEndedExpectedly) {
                return;
            }
            if (shouldObservationEndExpectedly) {
                test.pass("observeChannel should end expectedly by server");
            } else {
                test.fail("observeChannel should not be ended unexpectedly by server");
            }
        })
        .once("error", (error: ServiceError) => {
            if (test.context.isTearingdown()) {
                // Do not use test assertions here as test has already finished.
                // Error listener is required to prevent tapUncaughtException.
                return;
            }
            if (error.code === StatusCode.CANCELLED ||
                error.code === StatusCode.DEADLINE_EXCEEDED) {
                isCallEndedExpectedly = true;
            } else if (error.code === StatusCode.INVALID_ARGUMENT) {
                if (expectObservationFails !== error.code) {
                    test.fail("observeChannel should not fail with error status INVALID_ARGUMENT");
                } else {
                    test.pass("observeChannel should fail with error status INVALID_ARGUMENT");
                }
                isCallEndedExpectedly = true;
            } else if (error.code === StatusCode.UNAVAILABLE) {
                if (expectObservationFails !== error.code) {
                    test.fail("observeChannel should not fail with error status UNAVAILABLE");
                } else {
                    test.pass("observeChannel should fail with error status UNAVAILABLE");
                }
                isCallEndedExpectedly = true;
            } else {
                test.error(error);
            }
        });
    return () => new Promise<void>(resolve => {
        call.cancel();
        setTimeout(resolve, 500);
    });
}

function publishOnCall(
    test: typeof tap.Test.prototype,
    client: TnComClient,
    callOperation: string,
    callParams: TestOperationParams,
    expectPublicationFails?: StatusCode,
    cancelOrDeadlineAfter?: boolean | number,
    shouldCallEndExpectedlyByServer?: boolean): Promise<void> | CallReturnCancellation {
    const call = client.publishCall(
        {
            operation: callOperation,
            parameters: client.pkg.pack(callParams, "flowpro.tnc.test.TestOperationParams"),
            sourceId: client.sourceId,
        },
        typeof cancelOrDeadlineAfter === "number" ? { deadline: Date.now() + cancelOrDeadlineAfter } : {});
    test.context.addTeardown(() => call.cancel(), "start");
    const promise = new Promise<void>(resolve => {
        let isCallEndedExpectedly = false;
        const responseIndexes = new Map<string, number>();
        call
            .on("data", (evt: PbReturnEvent) => {
                const responseIndex = responseIndexes.get(evt.sourceId) ?? 0;
                test.ok(typeof evt.sourceId === "string" && UUID_REGEX.test(evt.sourceId));
                test.ok(("correlationId" in evt) && evt.correlationId === "");

                if (responseIndex === 0) {
                    test.ok(!("data" in evt));
                    test.strictSame(evt.error, { code: 42, message: "Foo" });
                    test.equal(evt.executionInfo, null);
                } else {
                    test.ok(!("error" in evt));
                    const data = client.pkg.unpack(evt.data, "flowpro.tnc.test.TestOperationResult") as TestOperationResult;
                    const execInfo = client.pkg.unpack(evt.executionInfo, "flowpro.tnc.test.TestOperationExecutionInfo") as
                        TestOperationExecutionInfo;
                    test.equal(data.value, responseIndex + 1);
                    test.equal(execInfo.responseIndex, responseIndex);
                }

                responseIndexes.set(evt.sourceId, responseIndex + 1);

                // Increment routing count by 0.5 for each response received.
                test.context.incrementTotalRoutingCount(0.5);

                // Resolve promise when all expected results have been received by all observers.
                if (Array.from(responseIndexes.values()).every(i => i === callParams.responseCount)) {
                    resolve();
                }
            })
            .once("end", () => {
                // Invoked on server call end or client call cancel/deadline exceeded.
                if (test.context.isTearingdown()) {
                    // Do not use test assertions here as test has already finished.
                    return;
                }
                if (isCallEndedExpectedly) {
                    return;
                }
                if (shouldCallEndExpectedlyByServer) {
                    test.pass("publishCall should end expectedly by server");
                } else {
                    test.fail("publishCall should not be ended unexpectedly by server");
                }
            })
            .once("error", (error: ServiceError) => {
                if (test.context.isTearingdown()) {
                    // Do not use test assertions here as test has already finished.
                    // Error listener is required to prevent tapUncaughtException.
                    return;
                }
                if (error.code === StatusCode.CANCELLED ||
                    error.code === StatusCode.DEADLINE_EXCEEDED) {
                    isCallEndedExpectedly = true;
                } else if (error.code === StatusCode.INVALID_ARGUMENT) {
                    if (expectPublicationFails !== error.code) {
                        test.fail("publishCall should not fail with error status INVALID_ARGUMENT");
                    } else {
                        test.pass("publishCall should fail with error status INVALID_ARGUMENT");
                    }
                    isCallEndedExpectedly = true;
                } else if (error.code === StatusCode.UNAVAILABLE) {
                    if (expectPublicationFails !== error.code) {
                        test.fail("publishCall should not fail with error status UNAVAILABLE");
                    } else {
                        test.pass("publishCall should fail with error status UNAVAILABLE");
                    }
                    isCallEndedExpectedly = true;
                } else {
                    test.error(error);
                }
            });
    });
    if (typeof cancelOrDeadlineAfter === "boolean" && cancelOrDeadlineAfter) {
        return (cancelDelay: number) => new Promise<void>(resolve => {
            setTimeout(() => {
                call.cancel();
                setTimeout(resolve, 500);
            }, cancelDelay ?? 200);
        });
    } else {
        return promise;
    }
}

function observeCall(
    test: typeof tap.Test.prototype,
    client: TnComClient,
    testSelector: PbCallSelector,
    expectObservationFails?: StatusCode,
    deadlineAfter?: number,
    shouldObservationEndExpectedly?: boolean) {
    const call = client.observeCall(testSelector, deadlineAfter ? { deadline: Date.now() + deadlineAfter } : undefined);
    let isCallEndedExpectedly = false;
    test.context.addTeardown(() => call.cancel(), "start");
    call
        .on("data", (evt: PbCallEvent) => {
            test.equal(evt.operation, testSelector.operation);
            test.ok(typeof evt.sourceId === "string" && UUID_REGEX.test(evt.sourceId));
            test.ok(typeof evt.correlationId === "string" && UUID_REGEX.test(evt.correlationId));
            test.ok(!("responseCallback" in evt));
            const params = client.pkg.unpack(evt.parameters, "flowpro.tnc.test.TestOperationParams") as TestOperationParams;
            test.ok("responseCount" in params && Number.isInteger(params.responseCount));
            test.ok("responseDelay" in params && Number.isInteger(params.responseDelay));
            let returnValue = 0;
            const interval = setInterval(() => {
                returnValue++;
                if (params.responseCount < returnValue) {
                    clearInterval(interval);
                    client.publishComplete(
                        { correlationId: evt.correlationId },
                        (error, ack) => {
                            error ? test.error(error) : test.strictSame(ack, {});
                            // Finally, increment routing count by 0.5 for last response to
                            // avoid premature shutdown of rpc channel on test end by client.
                            if (params.responseCount > 0) {
                                test.context.incrementTotalRoutingCount(0.5);
                            }
                        });
                    return;
                }
                client.publishReturn(
                    returnValue === 1 ? {
                        sourceId: client.sourceId,
                        correlationId: evt.correlationId,
                        error: { code: 42, message: "Foo" },
                    } : {
                        sourceId: client.sourceId,
                        correlationId: evt.correlationId,
                        data: client.pkg.pack({ value: returnValue }, "flowpro.tnc.test.TestOperationResult"),
                        executionInfo: client.pkg.pack({ responseIndex: returnValue - 1 }, "flowpro.tnc.test.TestOperationExecutionInfo"),
                    },
                    (error, ack) => error ? test.error(error) : test.strictSame(ack, {}));
                // Increment routing count by 0.5 for each response returned except last.
                if (params.responseCount > returnValue) {
                    test.context.incrementTotalRoutingCount(0.5);
                }
            }, params.responseDelay ?? 0);
        })
        .once("end", () => {
            // Invoked on server call end or client call cancel/deadline exceeded.
            if (test.context.isTearingdown()) {
                // Do not use test assertions here as test has already finished.
                return;
            }
            if (isCallEndedExpectedly) {
                return;
            }
            if (shouldObservationEndExpectedly) {
                test.pass("observeCall should end expectedly by server");
            } else {
                test.fail("observeCall should not be ended unexpectedly by server");
            }
        })
        .once("error", (error: ServiceError) => {
            if (test.context.isTearingdown()) {
                // Do not use test assertions here as test has already finished.
                // Error listener is required to prevent tapUncaughtException.
                return;
            }
            if (error.code === StatusCode.CANCELLED ||
                error.code === StatusCode.DEADLINE_EXCEEDED) {
                isCallEndedExpectedly = true;
            } else if (error.code === StatusCode.INVALID_ARGUMENT) {
                if (expectObservationFails !== error.code) {
                    test.fail("observeCall should not fail with error status INVALID_ARGUMENT");
                } else {
                    test.pass("observeCall should fail with error status INVALID_ARGUMENT");
                }
                isCallEndedExpectedly = true;
            } else if (error.code === StatusCode.UNAVAILABLE) {
                if (expectObservationFails !== error.code) {
                    test.fail("observeCall should not fail with error status UNAVAILABLE");
                } else {
                    test.pass("observeCall should fail with error status UNAVAILABLE");
                }
                isCallEndedExpectedly = true;
            } else {
                test.error(error);
            }
        });
    return () => new Promise<void>(resolve => {
        call.cancel();
        setTimeout(resolve, 500);
    });
}

/* Tests */

initTestContext(tap);

// Do not timeout tests in this suite.
tap.setTimeout(0);

tap.test("CommunicationService", async t => {
    const options = testTnConnectorOptions(t);
    const tnc = await TnConnector.start(options);

    await t.test("reconfigure Coaty communication options", async ts => {
        const currentTncOptions = { ...tnc.options };
        const client = await initTnComClient(ts);
        await configureComOptions(ts, tnc, client, {
            brokerUrl: currentTncOptions.coatyBrokerUrl,
            namespace: currentTncOptions.coatyNamespace + "NEW",
            agentIdentity: {
                name: currentTncOptions.coatyAgentIdentityName + "NEW",
                id: currentTncOptions.coatyAgentIdentityId + "NEW",
            },
        }, {
            coatyAgentIdentityName: currentTncOptions.coatyAgentIdentityName + "NEW",
            coatyAgentIdentityId: currentTncOptions.coatyAgentIdentityId + "NEW",
            coatyBrokerUrl: currentTncOptions.coatyBrokerUrl,
            coatyNamespace: currentTncOptions.coatyNamespace + "NEW",
            grpcProtoPath: currentTncOptions.grpcProtoPath,
            grpcServerPort: currentTncOptions.grpcServerPort,
        });

        // Reset changed options.
        await configureComOptions(ts, tnc, client, {
            brokerUrl: currentTncOptions.coatyBrokerUrl,
            namespace: currentTncOptions.coatyNamespace,
            agentIdentity: {
                name: currentTncOptions.coatyAgentIdentityName,
                id: currentTncOptions.coatyAgentIdentityId,
            },
        }, {
            coatyAgentIdentityName: currentTncOptions.coatyAgentIdentityName,
            coatyAgentIdentityId: currentTncOptions.coatyAgentIdentityId,
            coatyBrokerUrl: currentTncOptions.coatyBrokerUrl,
            coatyNamespace: currentTncOptions.coatyNamespace,
            grpcProtoPath: currentTncOptions.grpcProtoPath,
            grpcServerPort: currentTncOptions.grpcServerPort,
        });
    });

    await t.test("Channel", tnComTest(2, async ts => {
        const client1 = await initTnComClient(ts);
        const client2 = await initTnComClient(ts);
        observeChannel(ts, client2, { id: TestChannelId.Push });
        publishOnChannel(ts, client1, TestChannelId.Push, getChannelDataForSequenceId(1));
        publishOnChannel(ts, client1, TestChannelId.Push, getChannelDataForSequenceId(2));
    }));

    await t.test("Channel to self", tnComTest(2, async ts => {
        const client1 = await initTnComClient(ts);
        observeChannel(ts, client1, { id: TestChannelId.Push });
        publishOnChannel(ts, client1, TestChannelId.Push, getChannelDataForSequenceId(1));
        publishOnChannel(ts, client1, TestChannelId.Push, getChannelDataForSequenceId(2));
    }));

    await t.test("Channel discarded", tnComTest(0.5, async ts => {
        const client1 = await initTnComClient(ts);
        await publishOnChannel(ts, client1, TestChannelId.Push, getChannelDataForSequenceId(1), 200);
    }));

    await t.test("Channel with multiple observers", tnComTest(3, async ts => {
        const client1 = await initTnComClient(ts);
        const client2 = await initTnComClient(ts);
        observeChannel(ts, client2, { id: TestChannelId.Push });
        observeChannel(ts, client2, { id: TestChannelId.Push });
        publishOnChannel(ts, client1, TestChannelId.Push, getChannelDataForSequenceId(1));
        publishOnChannel(ts, client1, TestChannelId.Push, getChannelDataForSequenceId(2));
    }));

    await t.test("Channel with unobserve by cancellation", tnComTest(3, async ts => {
        const client1 = await initTnComClient(ts);
        const client2 = await initTnComClient(ts);
        const unobserveChannel1 = observeChannel(ts, client2, { id: TestChannelId.Push });
        const unobserveChannel2 = observeChannel(ts, client2, { id: TestChannelId.Push });
        await publishOnChannel(ts, client1, TestChannelId.Push, getChannelDataForSequenceId(1), 300);
        await unobserveChannel1();
        await publishOnChannel(ts, client1, TestChannelId.Push, getChannelDataForSequenceId(2), 300);
        await unobserveChannel2();
        await publishOnChannel(ts, client1, TestChannelId.Push, getChannelDataForSequenceId(3), 300);
    }));

    await t.test("Channel with unobserve by deadline exceeded", tnComTest(2, async ts => {
        const client1 = await initTnComClient(ts);
        const client2 = await initTnComClient(ts);
        observeChannel(ts, client2, { id: TestChannelId.Push }, undefined, 500);
        observeChannel(ts, client2, { id: TestChannelId.Push }, undefined, 500);
        await publishOnChannel(ts, client1, TestChannelId.Push, getChannelDataForSequenceId(1), 300);
        await new Promise(r => setTimeout(r, 700));
        await publishOnChannel(ts, client1, TestChannelId.Push, getChannelDataForSequenceId(2));
    }));

    await t.test("Channel with unobserve by communication manager stopped", tnComTest(2.5, async ts => {
        const currentTncOptions = { ...tnc.options };
        const client1 = await initTnComClient(ts);
        const client2 = await initTnComClient(ts);
        observeChannel(ts, client2, { id: TestChannelId.Push }, undefined, undefined, undefined, true);
        observeChannel(ts, client2, { id: TestChannelId.Push }, undefined, undefined, undefined, true);
        await publishOnChannel(ts, client1, TestChannelId.Push, getChannelDataForSequenceId(1), 300);

        await configureComOptions(ts, tnc, client1, {
            brokerUrl: currentTncOptions.coatyBrokerUrl,
            namespace: currentTncOptions.coatyNamespace + "NEW",
        }, {
            coatyBrokerUrl: currentTncOptions.coatyBrokerUrl,
            coatyNamespace: currentTncOptions.coatyNamespace + "NEW",
            grpcProtoPath: currentTncOptions.grpcProtoPath,
            grpcServerPort: currentTncOptions.grpcServerPort,
        });

        // Reconfiguring communication options stops Coaty communication manager
        // and automatically unsubscribes all registered Coaty event observables.
        await publishOnChannel(ts, client1, TestChannelId.Push, getChannelDataForSequenceId(2));
        await new Promise(r => setTimeout(r, 300));

        // Finally, force test to end.
        ts.context.incrementTotalRoutingCount(0.5);
    }));

    await t.test("Channel with fail fast while offline", tnComTest(0.5, async ts => {
        const currentTncOptions = { ...tnc.options };
        const client1 = await initTnComClient(ts);

        // Ensure fail fast behavior is enabled for next observation and publication
        // on channel.
        await configureComOptions(ts, tnc, client1, {
            brokerUrl: currentTncOptions.coatyBrokerUrl,
            namespace: currentTncOptions.coatyNamespace,
            notFailFastIfOffline: false,
        }, {
            coatyBrokerUrl: currentTncOptions.coatyBrokerUrl,
            coatyNamespace: currentTncOptions.coatyNamespace,
            coatyFailFastIfOffline: "true",
        });

        // Disconnect from Coaty network to ensure fail fast behavior is triggered
        // for next observation and publication on channel.
        await tnc.coatyAgent.communicationManager.stop();

        observeChannel(ts, client1, { id: TestChannelId.Push }, StatusCode.UNAVAILABLE, undefined, undefined, true);
        await publishOnChannel(ts, client1, TestChannelId.Push, getChannelDataForSequenceId(1), undefined, StatusCode.UNAVAILABLE);
        await new Promise(r => setTimeout(r, 300));

        // Reapply previous fail fast behavior for subsequent tests and start Coaty
        // agent again.
        await configureComOptions(ts, tnc, client1, {
            brokerUrl: currentTncOptions.coatyBrokerUrl,
            namespace: currentTncOptions.coatyNamespace,
            notFailFastIfOffline: currentTncOptions.coatyFailFastIfOffline !== "true",
        }, {
            coatyBrokerUrl: currentTncOptions.coatyBrokerUrl,
            coatyNamespace: currentTncOptions.coatyNamespace,
            coatyFailFastIfOffline: currentTncOptions.coatyFailFastIfOffline,
        });

        // Finally, force test to end.
        ts.context.incrementTotalRoutingCount(0.5);
    }));

    await t.test("Channel with empty channel id", tnComTest(0.5, async ts => {
        const client1 = await initTnComClient(ts);
        const client2 = await initTnComClient(ts);
        observeChannel(ts, client2, { id: TestChannelId.Empty }, StatusCode.INVALID_ARGUMENT);
        await publishOnChannel(ts, client1, TestChannelId.Empty, { foo: "foo", bar: 42 }, undefined, StatusCode.INVALID_ARGUMENT);

        // Finally, force test to end.
        ts.context.incrementTotalRoutingCount(0.5);
    }));

    await t.test("Channel with invalid channel id", tnComTest(0.5, async ts => {
        const client1 = await initTnComClient(ts);
        const client2 = await initTnComClient(ts);
        observeChannel(ts, client2, { id: TestChannelId.InvalidChars }, StatusCode.INVALID_ARGUMENT);
        await publishOnChannel(ts, client1, TestChannelId.InvalidChars, { foo: "foo", bar: 42 }, undefined, StatusCode.INVALID_ARGUMENT);

        // Finally, force test to end.
        ts.context.incrementTotalRoutingCount(0.5);
    }));

    await t.test("Channel with invalid data", tnComTest(1, async ts => {
        const client1 = await initTnComClient(ts);
        const client2 = await initTnComClient(ts);
        observeChannel(ts, client2, { id: TestChannelId.Push }, undefined, undefined, { seqId: 0, value: 0 });
        publishOnChannel(ts, client1, TestChannelId.Push, { foo: "foo", bar: 42 });
    }));

    await t.test("Call-Return", tnComTest(2, async ts => {
        const client1 = await initTnComClient(ts);
        const client2 = await initTnComClient(ts);
        observeCall(ts, client2, { operation: TestOperationId.Default });
        publishOnCall(ts, client1, TestOperationId.Default, { responseCount: 2, responseDelay: 0 });
    }));

    await t.test("Call-Return to self", tnComTest(2, async ts => {
        const client1 = await initTnComClient(ts);
        observeCall(ts, client1, { operation: TestOperationId.Default });
        publishOnCall(ts, client1, TestOperationId.Default, { responseCount: 1, responseDelay: 0 });
        publishOnCall(ts, client1, TestOperationId.Default, { responseCount: 1, responseDelay: 0 });
    }));

    await t.test("Call-Return discarded", tnComTest(0.5, async ts => {
        const client1 = await initTnComClient(ts);
        publishOnCall(ts, client1, TestOperationId.Default, { responseCount: 2, responseDelay: 0 });
        await new Promise(r => setTimeout(r, 300));

        // Finally, force test to end.
        ts.context.incrementTotalRoutingCount(0.5);
    }));

    await t.test("Call-Return with multiple observers with multiple results", tnComTest(8, async ts => {
        const client1 = await initTnComClient(ts);
        const client2 = await initTnComClient(ts);
        observeCall(ts, client1, { operation: TestOperationId.Default });
        observeCall(ts, client2, { operation: TestOperationId.Default });
        publishOnCall(ts, client1, TestOperationId.Default, { responseCount: 2, responseDelay: 0 });
        publishOnCall(ts, client1, TestOperationId.Default, { responseCount: 2, responseDelay: 0 });
    }));

    await t.test("Call-Return with no results", tnComTest(0.5, async ts => {
        const client1 = await initTnComClient(ts);
        observeCall(ts, client1, { operation: TestOperationId.Default });
        publishOnCall(ts, client1, TestOperationId.Default, { responseCount: 0, responseDelay: 0 });
        await new Promise(r => setTimeout(r, 300));

        // Finally, force test to end.
        ts.context.incrementTotalRoutingCount(0.5);
    }));

    await t.test("Call-Return with unobserve by cancellation", tnComTest(3.5, async ts => {
        const client1 = await initTnComClient(ts);
        const client2 = await initTnComClient(ts);
        const unobserveCall1 = observeCall(ts, client1, { operation: TestOperationId.Default });
        const unobserveCall2 = observeCall(ts, client2, { operation: TestOperationId.Default });
        await publishOnCall(ts, client1, TestOperationId.Default, { responseCount: 1, responseDelay: 0 });
        await unobserveCall1();
        await publishOnCall(ts, client1, TestOperationId.Default, { responseCount: 1, responseDelay: 0 });
        await unobserveCall2();
        publishOnCall(ts, client1, TestOperationId.Default, { responseCount: 1, responseDelay: 0 });
        await new Promise(r => setTimeout(r, 300));

        // Finally, force test to end.
        ts.context.incrementTotalRoutingCount(0.5);
    }));

    await t.test("Call-Return with unobserve by deadline exceeded", tnComTest(2.5, async ts => {
        const client1 = await initTnComClient(ts);
        const client2 = await initTnComClient(ts);
        observeCall(ts, client1, { operation: TestOperationId.Default }, undefined, 500);
        observeCall(ts, client2, { operation: TestOperationId.Default }, undefined, 500);
        await publishOnCall(ts, client1, TestOperationId.Default, { responseCount: 1, responseDelay: 0 });
        await new Promise(r => setTimeout(r, 1000));
        publishOnCall(ts, client1, TestOperationId.Default, { responseCount: 1, responseDelay: 0 });
        await new Promise(r => setTimeout(r, 300));

        // Finally, force test to end.
        ts.context.incrementTotalRoutingCount(0.5);
    }));

    await t.test("Call-Return with unobserve by communication manager stopped", tnComTest(1.5, async ts => {
        const currentTncOptions = { ...tnc.options };
        const client1 = await initTnComClient(ts);
        const client2 = await initTnComClient(ts);
        observeCall(ts, client2, { operation: TestOperationId.Default }, undefined, undefined, true);
        await publishOnCall(ts, client1, TestOperationId.Default, { responseCount: 1, responseDelay: 0 }, undefined, undefined, true);

        await configureComOptions(ts, tnc, client1, {
            brokerUrl: currentTncOptions.coatyBrokerUrl,
            namespace: currentTncOptions.coatyNamespace + "NEW",
        }, {
            coatyBrokerUrl: currentTncOptions.coatyBrokerUrl,
            coatyNamespace: currentTncOptions.coatyNamespace + "NEW",
            grpcProtoPath: currentTncOptions.grpcProtoPath,
            grpcServerPort: currentTncOptions.grpcServerPort,
        });

        // Reconfiguring communication options stops Coaty communication manager
        // and automatically unsubscribes all registered Coaty event observables.
        publishOnCall(ts, client1, TestOperationId.Default, { responseCount: 1, responseDelay: 0 });
        await new Promise(r => setTimeout(r, 300));

        // Finally, force test to end.
        ts.context.incrementTotalRoutingCount(0.5);
    }));

    await t.test("Call-Return with fail fast while offline", tnComTest(0.5, async ts => {
        const currentTncOptions = { ...tnc.options };
        const client1 = await initTnComClient(ts);

        // Ensure fail fast behavior is enabled for next observation and publication
        // on call-return.
        await configureComOptions(ts, tnc, client1, {
            brokerUrl: currentTncOptions.coatyBrokerUrl,
            namespace: currentTncOptions.coatyNamespace,
            notFailFastIfOffline: false,
        }, {
            coatyBrokerUrl: currentTncOptions.coatyBrokerUrl,
            coatyNamespace: currentTncOptions.coatyNamespace,
            coatyFailFastIfOffline: "true",
        });

        // Disconnect from Coaty network to ensure fail fast behavior is triggered
        // for next observation and publication on call-return.
        await tnc.coatyAgent.communicationManager.stop();

        observeCall(ts, client1, { operation: TestOperationId.Default }, StatusCode.UNAVAILABLE, undefined, true);
        publishOnCall(ts, client1, TestOperationId.Default, { responseCount: 1, responseDelay: 0 },
            StatusCode.UNAVAILABLE, undefined, true);
        await new Promise(r => setTimeout(r, 300));

        // Reapply previous fail fast behavior for subsequent tests and start Coaty
        // agent again.
        await configureComOptions(ts, tnc, client1, {
            brokerUrl: currentTncOptions.coatyBrokerUrl,
            namespace: currentTncOptions.coatyNamespace,
            notFailFastIfOffline: currentTncOptions.coatyFailFastIfOffline !== "true",
        }, {
            coatyBrokerUrl: currentTncOptions.coatyBrokerUrl,
            coatyNamespace: currentTncOptions.coatyNamespace,
            coatyFailFastIfOffline: currentTncOptions.coatyFailFastIfOffline,
        });

        // Finally, force test to end.
        ts.context.incrementTotalRoutingCount(0.5);
    }));

    // Prevent SIGTERM on tap process caused by a HTTP2/Server socket timeout in
    // GitLab CI/CD on the following two tests. Note that this error cannot be
    // reproduced in the same Docker environment running locally.
    if (process.env["FLOWPRO_TNC_INSIDE_TEST_CI"] !== "true") {
        await t.test("Call-Return with publish call deadline exceeded", tnComTest(1.5 + 0.5, async ts => {
            const client1 = await initTnComClient(ts);
            const client2 = await initTnComClient(ts);
            observeCall(ts, client2, { operation: TestOperationId.Default });
            publishOnCall(ts, client1, TestOperationId.Default, { responseCount: 2, responseDelay: 300 }, undefined, 400);
            await new Promise(r => setTimeout(r, 800));

            // Finally, force test to end.
            ts.context.incrementTotalRoutingCount(0.5);
        }));

        await t.test("Call-Return with publish call cancelled", tnComTest(1.5 + 0.5, async ts => {
            const client1 = await initTnComClient(ts);
            const client2 = await initTnComClient(ts);
            observeCall(ts, client2, { operation: TestOperationId.Default });
            await (publishOnCall(ts, client1, TestOperationId.Default, { responseCount: 2, responseDelay: 300 },
                undefined, true) as CallReturnCancellation)(400);
            await new Promise(r => setTimeout(r, 800));

            // Finally, force test to end.
            ts.context.incrementTotalRoutingCount(0.5);
        }));
    }

    await t.test("Call-Return with empty operation name", tnComTest(0.5, async ts => {
        const client1 = await initTnComClient(ts);
        const client2 = await initTnComClient(ts);
        observeCall(ts, client1, { operation: TestOperationId.Empty }, StatusCode.INVALID_ARGUMENT);
        publishOnCall(ts, client2, TestOperationId.Empty, { responseCount: 1, responseDelay: 0 }, StatusCode.INVALID_ARGUMENT);
        await new Promise(r => setTimeout(r, 300));

        // Finally, force test to end.
        ts.context.incrementTotalRoutingCount(0.5);
    }));

    await t.test("Call-Return with invalid operation name", tnComTest(0.5, async ts => {
        const client1 = await initTnComClient(ts);
        const client2 = await initTnComClient(ts);
        observeCall(ts, client1, { operation: TestOperationId.InvalidChars }, StatusCode.INVALID_ARGUMENT);
        publishOnCall(ts, client2, TestOperationId.InvalidChars, { responseCount: 1, responseDelay: 0 }, StatusCode.INVALID_ARGUMENT);
        await new Promise(r => setTimeout(r, 300));

        // Finally, force test to end.
        ts.context.incrementTotalRoutingCount(0.5);
    }));

    await t.test("Call-Return with unknown operation params", tnComTest(0.5, async ts => {
        const client1 = await initTnComClient(ts);
        const client2 = await initTnComClient(ts);
        observeCall(ts, client1, { operation: TestOperationId.Default });
        // Yields no response as default responseCount is zero.
        publishOnCall(ts, client2, TestOperationId.Default, { foo: "foo", bar: 42 } as unknown as TestOperationParams);
        await new Promise(r => setTimeout(r, 300));

        // Finally, force test to end.
        ts.context.incrementTotalRoutingCount(0.5);
    }));

    // This should always be the final test for any started TnConnector instance.
    await t.test("stop TNC", async ts => {
        ts.teardown(() => tnc.stop());
    });
});
