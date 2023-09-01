/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

import { CallOptions, ClientReadableStream, ClientUnaryCall, sendUnaryData, ServiceError, status as StatusCode } from "@grpc/grpc-js";
import * as tap from "tap";

import { TnConnector } from "../../common/tn-connector";
import { PushEvent, PushRoute, RequestEvent, RequestRoute, ResponseEvent, RouteEventAck, RoutingPolicy } from "../../service/routing-service";
import { initTestContext, testTnConnectorOptions } from "../test-context";
import { connectGrpcTestClient, GrpcTestClientWithPackage } from "../test-grpc";

/* Utility types and functions */

type RouteRequestCancellation = (cancelDelay?: number) => Promise<void>;

enum TestRouteId {
    Push = "flowpro.tnc.test.Push",
    Add = "flowpro.tnc.test.Add",
    Remainder = "flowpro.tnc.test.Remainder",
    MultiplyOnEmptyRoute = "",
}

interface RoutingClient extends GrpcTestClientWithPackage {
    registerPushRoute: (route: PushRoute, callOptions?: CallOptions) => ClientReadableStream<PushEvent>;
    registerRequestRoute: (route: RequestRoute, callOptions?: CallOptions) => ClientReadableStream<RequestEvent>;
    push: (event: PushEvent, cb: sendUnaryData<RouteEventAck>) => ClientUnaryCall;
    request: (event: RequestEvent, callOptions: CallOptions, cb?: sendUnaryData<ResponseEvent>) => ClientUnaryCall;
    respond: (event: ResponseEvent, cb: sendUnaryData<RouteEventAck>) => ClientUnaryCall;
}

type TestRoute = [route: PushRoute | RequestRoute, isTwoWay: boolean];

const testRoutes: { [key: string]: TestRoute } = {
    Push: [{ route: TestRouteId.Push }, false],
    PushAsTwoWay: [{ route: TestRouteId.Push }, true],
    AddSingleOnly: [{ route: TestRouteId.Add }, true],
    AddFirst: [{ route: TestRouteId.Add, routingPolicy: RoutingPolicy.First }, true],
    AddLast: [{ route: TestRouteId.Add, routingPolicy: RoutingPolicy.Last }, true],
    AddNext: [{ route: TestRouteId.Add, routingPolicy: RoutingPolicy.Next }, true],
    AddRandom: [{ route: TestRouteId.Add, routingPolicy: RoutingPolicy.Random }, true],
    RemainderSingleOnly: [{ route: TestRouteId.Remainder }, true],
    MultiplySingleOnlyOnEmptyRoute: [{ route: TestRouteId.MultiplyOnEmptyRoute }, true],
};

const requestResponseErrors = {
    remainderNaN: { error: "Invalid argument: Result is not a number" },
    noRegistrationAvailable: { code: StatusCode.UNAVAILABLE, details: "No registration available for request event" },
    responseDiscarded: { code: StatusCode.INVALID_ARGUMENT, details: "Response event discarded as no correlated registration exits" },
    requestCancelledByDeregistration: { code: StatusCode.CANCELLED, details: "Correlated registration deregistered before response" },
    requestCancelled: { code: StatusCode.CANCELLED, details: "*" },
    requestDeadlineExceeded: { code: StatusCode.DEADLINE_EXCEEDED, details: "*" },
};

const unexpectedPushDataItems = {
    dataFieldOmitted: { foo: 42 },
};

function routingTest(
    expectedTotalRoutingCount: number | [totalRoutingCount: number, additionalInvocations: number],
    testFunc: (test: typeof tap.Test.prototype) => void) {
    return (test: typeof tap.Test.prototype) => new Promise<void>(resolve => {
        const [expectedCount, expectedAdditionalInvocations] = Array.isArray(expectedTotalRoutingCount) ?
            expectedTotalRoutingCount :
            [expectedTotalRoutingCount, 0];
        let totalRoutingCount = 0;
        let additionalInvocations = -1;
        let isTestResolved = false;
        test.context.incrementTotalRoutingCount = (routingCount: number) => {
            totalRoutingCount += routingCount;
            if (isTestResolved) {
                test.fail(`should not be invoked after ending test`);
                return;
            }
            if (totalRoutingCount < expectedCount) {
                test.pass(`totalRoutingCount (${totalRoutingCount}) still less than expectedTotalRoutingCount (${expectedCount})`);
            } else if (totalRoutingCount === expectedCount) {
                additionalInvocations++;
                if (additionalInvocations === expectedAdditionalInvocations) {
                    test.pass(`totalRoutingCount (${totalRoutingCount}) equals expectedTotalRoutingCount (${expectedCount}) plus additional invocations (${expectedAdditionalInvocations})`);
                    isTestResolved = true;
                    resolve();
                }
            } else {
                // Fail fast as soon as expected total routing count is exceeded.
                test.fail(`totalRoutingCount (${totalRoutingCount}) should not exceed expectedTotalRoutingCount (${expectedCount}) plus additionalCount (${expectedAdditionalInvocations})`);
                isTestResolved = true;
                resolve();
            }
        };
        testFunc(test);
    });
}

function getPushDataForSequenceId(seqId: number) {
    return { seqId, value: seqId + 10 };
}

async function initRoutingClient(test: typeof tap.Test.prototype): Promise<RoutingClient> {
    const client = await connectGrpcTestClient<RoutingClient>(test, "flowpro.tnc.icc.RoutingService", ["tnc_test.proto"]);
    test.context.addTeardown(() => client.close(), "end");
    return client;
}

function pushOnRoute(
    test: typeof tap.Test.prototype,
    client: RoutingClient,
    route: string,
    pushData: any,
    expectedRoutingCount: number) {
    return new Promise<void>(resolve => {
        const call = client.push(
            pushData ? {
                route,
                data: client.pkg.pack(pushData, "flowpro.tnc.test.PushData"),
            } : {
                route,
            },
            (error, response) => {
                test.error(error);
                test.strictSame(response, { routingCount: expectedRoutingCount });
                test.context.incrementTotalRoutingCount(error ? 0 : response.routingCount);
                resolve();
            });
        test.context.addTeardown(() => call.cancel(), "start");
    });
}

function requestOnRoute(
    test: typeof tap.Test.prototype,
    client: RoutingClient,
    route: string,
    requestData: any,
    expectedResponseData?: any,
    expectedResponseError?: { code: StatusCode, details: string } | { error: string },
    cancelOrDeadlineAfter?: boolean | number): Promise<void> | RouteRequestCancellation {
    let call;
    const promise = new Promise<void>(resolve => {
        call = client.request(
            requestData ? {
                route,
                data: client.pkg.pack(requestData, "flowpro.tnc.test.ArithmeticOperands"),
            } : {
                route,
            },
            typeof cancelOrDeadlineAfter === "number" ? { deadline: Date.now() + cancelOrDeadlineAfter } : {},
            (error, response) => {
                if (error) {
                    if (test.context.isTearingdown()) {
                        // Ignore call cancellation error after test has ended.
                        resolve();
                        return;
                    }

                    test.equal(error.code, expectedResponseError["code"]);
                    if (expectedResponseError["details"] !== "*") {
                        test.equal(error.details, expectedResponseError["details"]);
                    } else {
                        test.pass(`matches expected error with code ${error.code} and details "${error.details}"`);
                    }

                    // Routing count stays at 0.5 for a gRPC error (no registration available, call cancellation).
                    test.context.incrementTotalRoutingCount(0.5);
                    resolve();
                    return;
                }

                if ("error" in response) {
                    test.strictSame(response.error, expectedResponseError["error"]);
                    test.equal(response.data, undefined);
                } else {
                    const result = client.pkg.unpack(response.data, "flowpro.tnc.test.ArithmeticResult");
                    test.strictSame(result, expectedResponseData);
                    test.equal(response.error, undefined);
                }

                // Routing count sums up to 1 as soon as both response event
                // and response acknowledgment have been received.
                test.context.incrementTotalRoutingCount(0.5);
                resolve();
            });
    });
    test.context.addTeardown(() => call.cancel(), "start");
    if (typeof cancelOrDeadlineAfter === "boolean" && cancelOrDeadlineAfter) {
        return (cancelDelay: number) => new Promise<void>(resolve => {
            setTimeout(() => {
                call.cancel();
                setTimeout(resolve, 500);
            }, cancelDelay ?? 0);
        });
    } else {
        return promise;
    }
}

function registerRoute(
    test: typeof tap.Test.prototype,
    client: RoutingClient,
    testRoute: TestRoute,
    expectRegistrationFails?: boolean,
    deadlineAfter?: number,
    delayResponse?: number,
    expectedResponseCallbackError?: { code: StatusCode, details: string } | { routingCount: number },
    provokeUncorrelatedError?: () => { code: StatusCode, details: string },
    unexpectedPushData?: { [key: string]: any }) {
    const [route, isTwoWay] = testRoute;
    const call = isTwoWay ?
        client.registerRequestRoute(route, deadlineAfter ? { deadline: Date.now() + deadlineAfter } : undefined) :
        client.registerPushRoute(route, deadlineAfter ? { deadline: Date.now() + deadlineAfter } : undefined);
    let isCallEndedExpectedly = false;
    let pushSeqId = 0;
    test.context.addTeardown(() => call.cancel(), "start");
    call
        .on("data", (event: PushEvent | RequestEvent) => {
            test.equal(event.route, route.route);
            if (isTwoWay) {
                const evt = event as RequestEvent;
                test.ok(Number.isInteger(evt.requestId) && evt.requestId >= 1 && evt.requestId <= 0xFFFFFFFF);
                let value: any;
                if (!evt.data) {
                    value = 42;
                } else {
                    const data = client.pkg.unpack(evt.data, "flowpro.tnc.test.ArithmeticOperands");
                    value = (evt.route === TestRouteId.Add || evt.route === TestRouteId.Push) ? data.operand1 + data.operand2 :
                        (evt.route === TestRouteId.MultiplyOnEmptyRoute ? data.operand1 * data.operand2 :
                            data.operand1 % data.operand2);
                }
                if (provokeUncorrelatedError) {
                    setTimeout(() => client.respond(
                        {
                            route: evt.route,
                            requestId: evt.requestId + 100,
                            data: client.pkg.pack({ value }, "flowpro.tnc.test.ArithmeticResult"),
                        },
                        (error, ack) => {
                            const uncorrelatedError = provokeUncorrelatedError();
                            test.notOk(ack);
                            test.equal(error.code, uncorrelatedError.code);
                            test.equal(error.details, uncorrelatedError.details);

                            // Force test to end immediately as no response
                            // event or error is ever emitted to requester.
                            test.context.incrementTotalRoutingCount(1);
                        }), delayResponse ?? 0);
                } else if (isNaN(value)) {
                    setTimeout(() => client.respond(
                        {
                            route: evt.route,
                            requestId: evt.requestId,
                            ...requestResponseErrors.remainderNaN,
                        },
                        (error, ack) => {
                            if (error) {
                                if (expectedResponseCallbackError && "code" in expectedResponseCallbackError) {
                                    test.equal(error.code, expectedResponseCallbackError.code);
                                    test.equal(error.details, expectedResponseCallbackError.details);
                                } else {
                                    test.error(error);
                                }
                            } else if (expectedResponseCallbackError && "routingCount" in expectedResponseCallbackError) {
                                test.strictSame(ack, { routingCount: expectedResponseCallbackError.routingCount });
                            } else {
                                test.strictSame(ack, { routingCount: 1 });
                            }

                            // Routing count sums up to 1 as soon as both response
                            // event and response acknowledgment have been received.
                            test.context.incrementTotalRoutingCount(0.5);
                        }), delayResponse ?? 0);
                } else {
                    setTimeout(() => client.respond(
                        {
                            route: evt.route,
                            requestId: evt.requestId,
                            data: client.pkg.pack({ value }, "flowpro.tnc.test.ArithmeticResult"),
                        },
                        (error, ack) => {
                            if (error) {
                                if (expectedResponseCallbackError && "code" in expectedResponseCallbackError) {
                                    test.equal(error.code, expectedResponseCallbackError.code);
                                    test.equal(error.details, expectedResponseCallbackError.details);
                                } else {
                                    test.error(error);
                                }
                            } else if (expectedResponseCallbackError && "routingCount" in expectedResponseCallbackError) {
                                test.strictSame(ack, { routingCount: expectedResponseCallbackError.routingCount });
                            } else {
                                test.strictSame(ack, { routingCount: 1 });
                            }

                            // Routing count sums up to 1 as soon as both response
                            // event and response acknowledgment have been received.
                            test.context.incrementTotalRoutingCount(0.5);
                        }), delayResponse ?? 0);
                }
            } else {
                const evt = event as PushEvent;
                const data = evt.data ? client.pkg.unpack(evt.data, "flowpro.tnc.test.PushData") : unexpectedPushDataItems.dataFieldOmitted;
                if (unexpectedPushData) {
                    test.strictSame(data, unexpectedPushData);
                } else {
                    test.strictSame(data, getPushDataForSequenceId(++pushSeqId));
                }
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
            test.fail("registration should not be ended unexpectedly by server");
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
                if (!expectRegistrationFails) {
                    test.fail("registration should not fail");
                } else {
                    test.pass("registration should fail");
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

tap.test("RoutingService", async t => {
    const options = testTnConnectorOptions(t);
    const tnc = await TnConnector.start(options);

    await t.test("Push", routingTest(4, async ts => {
        const client1 = await initRoutingClient(ts);
        const client2 = await initRoutingClient(ts);
        registerRoute(ts, client2, testRoutes.Push);
        registerRoute(ts, client2, testRoutes.Push);
        pushOnRoute(ts, client1, TestRouteId.Push, getPushDataForSequenceId(1), 2);
        pushOnRoute(ts, client1, TestRouteId.Push, getPushDataForSequenceId(2), 2);
    }));

    await t.test("Push to self", routingTest(4, async ts => {
        const client1 = await initRoutingClient(ts);
        registerRoute(ts, client1, testRoutes.Push);
        registerRoute(ts, client1, testRoutes.Push);
        pushOnRoute(ts, client1, TestRouteId.Push, getPushDataForSequenceId(1), 2);
        pushOnRoute(ts, client1, TestRouteId.Push, getPushDataForSequenceId(2), 2);
    }));

    await t.test("Push with omitted data field", routingTest(1, async ts => {
        const client1 = await initRoutingClient(ts);
        const client2 = await initRoutingClient(ts);
        registerRoute(ts, client2, testRoutes.Push, false, undefined, undefined, undefined, undefined,
            unexpectedPushDataItems.dataFieldOmitted);
        pushOnRoute(ts, client1, TestRouteId.Push, undefined, 1);
    }));

    await t.test("Push discarded", routingTest(0, async ts => {
        const client1 = await initRoutingClient(ts);
        pushOnRoute(ts, client1, TestRouteId.Push, getPushDataForSequenceId(1), 0);
    }));

    await t.test("Push with deregistration by cancellation", routingTest([3, 1], async ts => {
        const client1 = await initRoutingClient(ts);
        const client2 = await initRoutingClient(ts);
        const deregisterRoute1 = registerRoute(ts, client2, testRoutes.Push);
        const deregisterRoute2 = registerRoute(ts, client2, testRoutes.Push);
        await pushOnRoute(ts, client1, TestRouteId.Push, getPushDataForSequenceId(1), 2);
        await deregisterRoute1();
        await pushOnRoute(ts, client1, TestRouteId.Push, getPushDataForSequenceId(2), 1);
        await deregisterRoute2();
        pushOnRoute(ts, client1, TestRouteId.Push, getPushDataForSequenceId(3), 0);
    }));

    await t.test("Push with deregistration by deadline exceeded", routingTest([2, 1], async ts => {
        const client1 = await initRoutingClient(ts);
        const client2 = await initRoutingClient(ts);
        registerRoute(ts, client2, testRoutes.Push, false, 500);
        registerRoute(ts, client2, testRoutes.Push, false, 500);
        await pushOnRoute(ts, client1, TestRouteId.Push, getPushDataForSequenceId(1), 2);
        await new Promise(r => setTimeout(r, 1000));
        pushOnRoute(ts, client1, TestRouteId.Push, getPushDataForSequenceId(2), 0);
    }));

    await t.test("Push invalid data", routingTest(1, async ts => {
        const client1 = await initRoutingClient(ts);
        const client2 = await initRoutingClient(ts);
        registerRoute(ts, client2, testRoutes.Push, undefined, undefined, undefined, undefined, undefined, { seqId: 0, value: 0 });
        pushOnRoute(ts, client1, TestRouteId.Push, { foo: "foo", bar: 42 }, 1);
    }));

    await t.test("Request-Respond", routingTest(4, async ts => {
        const client1 = await initRoutingClient(ts);
        const client2 = await initRoutingClient(ts);
        registerRoute(ts, client2, testRoutes.AddSingleOnly);
        registerRoute(ts, client2, testRoutes.RemainderSingleOnly);
        requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 2 }, { value: 44 });
        requestOnRoute(ts, client1, TestRouteId.Remainder, { operand1: 43, operand2: 42 }, { value: 1 });
        requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 4 }, { value: 46 });
        requestOnRoute(ts, client1, TestRouteId.Remainder, { operand1: -43, operand2: 4 }, { value: -3 });
    }));

    await t.test("Request-Respond on push route", routingTest(1, async ts => {
        const client1 = await initRoutingClient(ts);
        const client2 = await initRoutingClient(ts);
        registerRoute(ts, client2, testRoutes.PushAsTwoWay);
        requestOnRoute(ts, client1, TestRouteId.Push, { operand1: 42, operand2: 8 }, { value: 50 });
    }));

    await t.test("Request-Respond with omitted data field", routingTest(1, async ts => {
        const client1 = await initRoutingClient(ts);
        const client2 = await initRoutingClient(ts);
        registerRoute(ts, client2, testRoutes.PushAsTwoWay);
        requestOnRoute(ts, client1, TestRouteId.Push, undefined, { value: 42 });
    }));

    await t.test("Request-Respond on empty route", routingTest(1, async ts => {
        const client1 = await initRoutingClient(ts);
        const client2 = await initRoutingClient(ts);
        registerRoute(ts, client2, testRoutes.MultiplySingleOnlyOnEmptyRoute);
        requestOnRoute(ts, client1, TestRouteId.MultiplyOnEmptyRoute, { operand1: 42, operand2: 2 }, { value: 84 });
    }));

    await t.test("Request-Respond with result error", routingTest(1, async ts => {
        const client1 = await initRoutingClient(ts);
        const client2 = await initRoutingClient(ts);
        registerRoute(ts, client2, testRoutes.RemainderSingleOnly);
        requestOnRoute(ts, client1, TestRouteId.Remainder, { operand1: 43, operand2: 0 }, undefined,
            requestResponseErrors.remainderNaN);
    }));

    await t.test("Request-Respond with self registration", routingTest(1, async ts => {
        const client1 = await initRoutingClient(ts);
        registerRoute(ts, client1, testRoutes.RemainderSingleOnly);
        requestOnRoute(ts, client1, TestRouteId.Remainder, { operand1: 43, operand2: -4 }, { value: 3 });
    }));

    await t.test("Request-Respond with no registration available", routingTest(0.5, async ts => {
        const client1 = await initRoutingClient(ts);
        requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 2 }, undefined,
            requestResponseErrors.noRegistrationAvailable);
    }));

    await t.test("Request-Respond with uncorrelated response", routingTest(1, async ts => {
        const client1 = await initRoutingClient(ts);
        const client2 = await initRoutingClient(ts);
        registerRoute(ts, client2, testRoutes.AddSingleOnly, false, undefined, undefined, undefined,
            () => (requestResponseErrors.responseDiscarded));
        requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 2 });
    }));

    await t.test("Request-Respond with additional default policy registration", routingTest(1, async ts => {
        const client1 = await initRoutingClient(ts);
        const client2 = await initRoutingClient(ts);
        registerRoute(ts, client2, testRoutes.AddSingleOnly, false);
        registerRoute(ts, client2, testRoutes.AddSingleOnly, true);
        requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 2 }, { value: 44 });
    }));

    await t.test("Request-Respond with default policy registration and additional non-default policy registrations",
        routingTest(1, async ts => {
            const client1 = await initRoutingClient(ts);
            const client2 = await initRoutingClient(ts);
            registerRoute(ts, client1, testRoutes.AddSingleOnly, false);
            registerRoute(ts, client2, testRoutes.AddFirst, true);
            registerRoute(ts, client2, testRoutes.AddLast, true);
            registerRoute(ts, client1, testRoutes.AddNext, true);
            registerRoute(ts, client2, testRoutes.AddRandom, true);
            requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 2 }, { value: 44 });
        }));

    await t.test("Request-Respond with additional non-default policy registrations", routingTest(1, async ts => {
        const client1 = await initRoutingClient(ts);
        const client2 = await initRoutingClient(ts);
        registerRoute(ts, client1, testRoutes.AddFirst, false);
        registerRoute(ts, client2, testRoutes.AddLast, true);
        registerRoute(ts, client1, testRoutes.AddNext, true);
        registerRoute(ts, client2, testRoutes.AddRandom, true);
        registerRoute(ts, client1, testRoutes.AddSingleOnly, true);
        requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 2 }, { value: 44 });
    }));

    await t.test("Request-Respond with routing policy First", routingTest(1, async ts => {
        const client1 = await initRoutingClient(ts);
        registerRoute(ts, client1, testRoutes.AddFirst);
        registerRoute(ts, client1, testRoutes.AddFirst);
        requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 2 }, { value: 44 });
    }));

    await t.test("Request-Respond with routing policy Last", routingTest(1, async ts => {
        const client1 = await initRoutingClient(ts);
        registerRoute(ts, client1, testRoutes.AddLast);
        registerRoute(ts, client1, testRoutes.AddLast);
        requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 2 }, { value: 44 });
    }));

    await t.test("Request-Respond with routing policy Next", routingTest(3, async ts => {
        const client1 = await initRoutingClient(ts);
        registerRoute(ts, client1, testRoutes.AddNext);
        registerRoute(ts, client1, testRoutes.AddNext);
        requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 2 }, { value: 44 });
        requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 3 }, { value: 45 });
        requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 4 }, { value: 46 });
    }));

    await t.test("Request-Respond with routing policy Random", routingTest(3, async ts => {
        const client1 = await initRoutingClient(ts);
        registerRoute(ts, client1, testRoutes.AddRandom);
        registerRoute(ts, client1, testRoutes.AddRandom);
        requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 2 }, { value: 44 });
        requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 3 }, { value: 45 });
        requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 4 }, { value: 46 });
    }));

    await t.test("Request-Respond with deregistration by cancellation", routingTest(2.5, async ts => {
        const client1 = await initRoutingClient(ts);
        const client2 = await initRoutingClient(ts);
        const deregisterRoute1 = registerRoute(ts, client2, testRoutes.AddFirst);
        const deregisterRoute2 = registerRoute(ts, client2, testRoutes.AddFirst);
        await requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 2 }, { value: 44 });
        await deregisterRoute1();
        await requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 3 }, { value: 45 });
        await deregisterRoute2();
        requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 4 }, undefined,
            requestResponseErrors.noRegistrationAvailable);
    }));

    await t.test("Request-Respond with deregistration by deadline exceeded", routingTest(1.5, async ts => {
        const client1 = await initRoutingClient(ts);
        const client2 = await initRoutingClient(ts);
        registerRoute(ts, client2, testRoutes.AddNext, false, 500);
        registerRoute(ts, client2, testRoutes.AddNext, false, 500);
        await requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 2 }, { value: 44 });
        await new Promise(r => setTimeout(r, 1000));
        requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 4 }, undefined,
            requestResponseErrors.noRegistrationAvailable);
    }));

    await t.test("Request-Respond with request cancellation", routingTest(1, async ts => {
        const client1 = await initRoutingClient(ts);
        const client2 = await initRoutingClient(ts);
        registerRoute(ts, client2, testRoutes.AddSingleOnly, false, undefined, 500, { routingCount: 0 });
        const cancelRequest = requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 2 },
            undefined, requestResponseErrors.requestCancelled, true) as RouteRequestCancellation;
        await cancelRequest();
    }));

    await t.test("Request-Respond with request deadline exceeded", routingTest(1, async ts => {
        const client1 = await initRoutingClient(ts);
        const client2 = await initRoutingClient(ts);
        registerRoute(ts, client2, testRoutes.AddSingleOnly, false, undefined, 500, { routingCount: 0 });
        await requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 2 }, undefined,
            requestResponseErrors.requestDeadlineExceeded, 200);
    }));

    await t.test("Request-Respond with request cancellation by deregistration", routingTest(1, async ts => {
        const client1 = await initRoutingClient(ts);
        const client2 = await initRoutingClient(ts);
        const deregisterRoute = registerRoute(ts, client2, testRoutes.AddSingleOnly, false, undefined, 500,
            requestResponseErrors.responseDiscarded);
        requestOnRoute(ts, client1, TestRouteId.Add, { operand1: 42, operand2: 2 }, undefined,
            requestResponseErrors.requestCancelledByDeregistration);
        // Ensure request event arrives at responder before deregistration.
        await new Promise(r => setTimeout(r, 200));
        await deregisterRoute();
    }));

    // This should always be the final test for any started TnConnector instance.
    await t.test("stop TNC", async ts => {
        ts.teardown(() => tnc.stop());
    });
});
