/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

import { RaftController } from "@coaty/consensus.raft";
import {
    CallOptions,
    ClientReadableStream,
    ClientUnaryCall,
    sendUnaryData,
    ServiceError,
    status as StatusCode,
} from "@grpc/grpc-js";
import * as fse from "fs-extra";
import { Subject } from "rxjs";
import * as tap from "tap";

import { TnConnector, TnConnectorOptions } from "../../common/tn-connector";
import { KVRaftStateMachine } from "../../controller/tn-consensus-controller";
import {
    RaftAck,
    RaftClusterConfiguration,
    RaftInput,
    RaftInputOperation,
    RaftNodeCreateOptions,
    RaftNodeRef,
    RaftState,
} from "../../service/tn-consensus-service";
import { initTestContext, testTnConnectorOptions } from "../test-context";
import { connectGrpcTestClient, GrpcTestClientWithPackage } from "../test-grpc";

/* Utility types and functions */

interface TnConsensusClient extends GrpcTestClientWithPackage {
    create: (createOptions: RaftNodeCreateOptions, cb: sendUnaryData<RaftNodeRef>) => ClientUnaryCall;
    connect: (nodeRef: RaftNodeRef, cb: sendUnaryData<RaftAck>) => ClientUnaryCall;
    disconnect: (nodeRef: RaftNodeRef, cb: sendUnaryData<RaftAck>) => ClientUnaryCall;
    stop: (nodeRef: RaftNodeRef, cb: sendUnaryData<RaftAck>) => ClientUnaryCall;
    propose: (input: RaftInput, cb: sendUnaryData<RaftState>) => ClientUnaryCall;
    getState: (nodeRef: RaftNodeRef, cb: sendUnaryData<RaftState>) => ClientUnaryCall;
    observeState: (nodeRef: RaftNodeRef, callOptions?: CallOptions) => ClientReadableStream<RaftState>;
    getClusterConfiguration: (nodeRef: RaftNodeRef, cb: sendUnaryData<RaftClusterConfiguration>) => ClientUnaryCall;
    observeClusterConfiguration: (nodeRef: RaftNodeRef, callOptions?: CallOptions) => ClientReadableStream<RaftClusterConfiguration>;
}

async function initTnConsensusClient(test: typeof tap.Test.prototype, agentIndex: number): Promise<TnConsensusClient> {
    const client = await connectGrpcTestClient<TnConsensusClient>(test, "flowpro.tnc.consensus.ConsensusService", [], agentIndex);
    test.context.addTeardown(() => client.close(), "end");
    return client;
}

async function createRaftNode(
    test: typeof tap.Test.prototype,
    tnc: TnConnector,
    client: TnConsensusClient,
    createOptions: RaftNodeCreateOptions) {
    return new Promise<RaftNodeRef>(resolve => {
        const call = client.create(createOptions, (error, nodeRef) => {
            if (error) {
                test.fail(error.details);
                resolve(undefined);
            } else {
                test.ok("id" in nodeRef);
                test.equal(typeof nodeRef.id, "string");
                test.equal(Object.keys(nodeRef).length, 1);
                const raftCtrl = tnc.coatyAgent.getController<RaftController>("RaftController" + nodeRef.id);
                test.not(raftCtrl, undefined);
                test.ok(raftCtrl instanceof RaftController);
                test.equal(raftCtrl.options.id, nodeRef.id);
                test.equal(raftCtrl.options.cluster, createOptions.cluster ?? "");
                test.equal(raftCtrl.options.shouldCreateCluster, !!createOptions.shouldCreateCluster);
                test.equal(raftCtrl.options.databaseKey, "raftStore");
                test.ok(raftCtrl.options.stateMachine instanceof KVRaftStateMachine);
                resolve(nodeRef);
            }
        });
        test.context.addTeardown(() => call.cancel(), "start");
    });
}

async function unaryCall(
    op: "connect" | "disconnect" | "stop" | "propose" | "getState" | "getClusterConfiguration",
    test: typeof tap.Test.prototype,
    client: TnConsensusClient,
    nodeRefOrInput: RaftNodeRef | RaftInput,
    expectedResultOrTimeout: RaftAck | RaftState | RaftClusterConfiguration |
        ((result: RaftAck | RaftState | RaftClusterConfiguration) => boolean) |
        number,
    expectErrorStatus?: { code: StatusCode, details: string }) {
    return new Promise<void>(resolve => {
        const call = client[op](nodeRefOrInput as any, (error, result) => {
            if (typeof expectedResultOrTimeout === "number") {
                if (error?.code !== StatusCode.CANCELLED) {
                    test.fail(`${op} should time out but not return ${error ?? result}`);
                }
                resolve();
                return;
            }
            if (error) {
                if (expectErrorStatus !== undefined) {
                    if (error.code === expectErrorStatus.code &&
                        (expectErrorStatus.details === "*" || error.details === expectErrorStatus.details)) {
                        test.pass(`${op} should fail with error status ${StatusCode[error.code]} (${error.code}): ${error.details}`);
                    } else {
                        test.fail(`${op} should not fail with unexpected error status code ${StatusCode[error.code]} (${error.code}): ${error.details}`);
                    }
                } else {
                    test.error(error);
                }
                resolve();
            } else {
                if (typeof expectedResultOrTimeout === "function") {
                    test.ok(expectedResultOrTimeout(result));
                } else {
                    test.strictSame(result, expectedResultOrTimeout);
                }
                resolve();
            }
        });
        if (typeof expectedResultOrTimeout === "number") {
            setTimeout(() => {
                call.cancel();
                test.pass(`${op} timed out expectedly`);
                resolve();
            }, expectedResultOrTimeout);
        }
        test.context.addTeardown(() => call.cancel(), "start");
    });
}

async function streamingCall(
    op: "observeState" | "observeClusterConfiguration",
    test: typeof tap.Test.prototype,
    client: TnConsensusClient,
    nodeRef: RaftNodeRef,
    expectedResult: RaftState[] | Array<(result: RaftClusterConfiguration) => boolean>,
    completeCallOn?: Subject<void>,
    expectCallFails?: { code: StatusCode, details: string },
    shouldCallEndExpectedlyByServer?: boolean) {
    return new Promise<void>(resolve => {
        const call = client[op](nodeRef);
        const resultCache = [...expectedResult];
        let isCallEndedExpectedly = false;
        test.context.addTeardown(() => call.cancel(), "start");
        completeCallOn?.subscribe({
            complete: () => call.cancel(),
        });
        call
            .on("data", (event: RaftState | RaftClusterConfiguration) => {
                const item = resultCache.shift();
                if (item === undefined) {
                    test.fail(`${op} got surplus event ${JSON.stringify(event)}`);
                } else if (typeof item === "function") {
                    test.ok(item(event as RaftClusterConfiguration));
                } else {
                    test.strictSame(event, item);
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

                if (shouldCallEndExpectedlyByServer) {
                    test.equal(resultCache.length, 0);
                    test.pass(`${op} should be ended expectedly by server`);
                } else {
                    test.fail(`${op} should not be ended unexpectedly by server`);
                }
                resolve();
            })
            .once("error", (error: ServiceError) => {
                if (test.context.isTearingdown()) {
                    // Do not use test assertions here as test has already finished.
                    // Error listener is required to prevent tapUncaughtException.
                    return;
                }
                if (error.code === StatusCode.CANCELLED) {
                    test.equal(resultCache.length, 0);
                    isCallEndedExpectedly = true;
                } else if (error.code === StatusCode.INVALID_ARGUMENT) {
                    if (expectCallFails?.code !== error.code || expectCallFails?.details !== error.details) {
                        test.fail(`${op} should not fail with error status INVALID_ARGUMENT`);
                    } else {
                        test.pass(`${op} should fail with error status INVALID_ARGUMENT`);
                    }
                    isCallEndedExpectedly = true;
                } else if (error.code === StatusCode.UNAVAILABLE) {
                    if (expectCallFails?.code !== error.code || expectCallFails?.details !== error.details) {
                        test.fail(`${op} should not fail with error status UNAVAILABLE`);
                    } else {
                        test.pass(`${op} should fail with error status UNAVAILABLE`);
                    }
                    isCallEndedExpectedly = true;
                } else {
                    test.error(error);
                }
            });
    });
}

function testClusterConfiguration(found: RaftClusterConfiguration, expected: RaftClusterConfiguration) {
    return found.ids.length === expected.ids.length && found.ids.every(v => expected.ids.includes(v));
}

function testTnConnectorOptionsWithFailFast(
    test: typeof tap.Test.prototype,
    agentIndex = 0,
    agentNamePrefix = "Raft agent host",
): TnConnectorOptions {
    return Object.assign(testTnConnectorOptions(test, agentIndex, agentNamePrefix), { coatyFailFastIfOffline: "true" });
}

/* Tests */

initTestContext(tap);

// Do not timeout tests in this suite.
tap.setTimeout(0);

tap.test("ConsensusService", async t => {
    const tnc1 = await TnConnector.start(testTnConnectorOptionsWithFailFast(t, 1));
    const tnc2 = await TnConnector.start(testTnConnectorOptionsWithFailFast(t, 2));
    const client1 = await initTnConsensusClient(t, 1);
    const client2 = await initTnConsensusClient(t, 2);
    const nodeRef1 = await createRaftNode(t, tnc1, client1, { shouldCreateCluster: true });
    const nodeRef2 = await createRaftNode(t, tnc1, client1, { shouldCreateCluster: false });
    const nodeRef3 = await createRaftNode(t, tnc2, client2, {});
    let lastState: RaftState;

    await t.test("connect Raft nodes", async ts => {
        await unaryCall("connect", ts, client1, nodeRef1, {});

        const completionSubject = new Subject<void>();

        // Note that cluster changes are only emitted when a new node connects.
        const promise = streamingCall("observeClusterConfiguration", ts, client1, nodeRef1, [
            found => testClusterConfiguration(found, { ids: [nodeRef1.id, nodeRef2.id] }),
            found => testClusterConfiguration(found, { ids: [nodeRef1.id, nodeRef2.id, nodeRef3.id] }),
        ], completionSubject);

        await unaryCall("connect", ts, client1, nodeRef2, {});
        await unaryCall("connect", ts, client2, nodeRef3, {});

        // Complete cluster observation.
        completionSubject.complete();
        await promise;
    });

    await t.test("get initial cluster configuration", async ts => {
        const ids = new Set([nodeRef1.id, nodeRef2.id, nodeRef3.id]);
        const testResult = (r: RaftClusterConfiguration) => ts.strictSame(new Set(r.ids), ids);
        await Promise.allSettled([
            unaryCall("getClusterConfiguration", ts, client1, nodeRef1, testResult),
            unaryCall("getClusterConfiguration", ts, client1, nodeRef2, testResult),
            unaryCall("getClusterConfiguration", ts, client2, nodeRef3, testResult),
        ]);
    });

    await t.test("get initial state", async ts => {
        lastState = { keyValuePairs: {} };
        await Promise.allSettled([
            unaryCall("getState", ts, client1, nodeRef1, lastState),
            unaryCall("getState", ts, client1, nodeRef2, lastState),
            unaryCall("getState", ts, client2, nodeRef3, lastState),
        ]);
    });

    const completionSubjectObserveState = new Subject<void>();
    let observeStatePromise: Promise<void>;

    const stateRef1: RaftState = { keyValuePairs: { foo: { numberValue: 42 } } };
    const stateRef2: RaftState = { keyValuePairs: { foo: { stringValue: "42" } } };
    const stateRef3: RaftState = { keyValuePairs: { foo: { listValue: { values: [{ numberValue: 42 }, { stringValue: "42" }] } } } };

    // To represent a null value of type google.protobuf.Value, the oneof field
    // null_value with value NULL_VALUE (singleton enum = 0) must be used or the
    // value field must be omitted.
    const stateRefNullValue: RaftState = { keyValuePairs: { foo: { nullValue: 0 } } };
    const stateRefNoValue: RaftState = { keyValuePairs: { foo: null } };

    await t.test("observeState while proposing", async ts => {
        observeStatePromise = streamingCall("observeState", ts, client1, nodeRef1,
            [stateRef1, stateRef2, stateRef3], completionSubjectObserveState);
    });

    await t.test("propose foo:42", async ts => {
        const inputRef1: RaftInput = {
            ref: nodeRef1,
            op: RaftInputOperation.Put,
            key: "foo",
            value: stateRef1.keyValuePairs.foo,
        };
        lastState = stateRef1;
        await unaryCall("propose", ts, client1, inputRef1, lastState);
        await Promise.allSettled([
            unaryCall("getState", ts, client1, nodeRef1, lastState),
            unaryCall("getState", ts, client1, nodeRef2, lastState),
            unaryCall("getState", ts, client2, nodeRef3, lastState),
        ]);
    });

    await t.test("propose foo:'42'", async ts => {
        const inputRef2: RaftInput = {
            ref: nodeRef2,
            op: RaftInputOperation.Put,
            key: "foo",
            value: stateRef2.keyValuePairs.foo,
        };
        lastState = stateRef2;
        await unaryCall("propose", ts, client1, inputRef2, lastState);
        await Promise.allSettled([
            unaryCall("getState", ts, client1, nodeRef1, lastState),
            unaryCall("getState", ts, client1, nodeRef2, lastState),
            unaryCall("getState", ts, client2, nodeRef3, lastState),
        ]);
    });

    await t.test("propose foo:[42,'42']", async ts => {
        const inputRef3: RaftInput = {
            ref: nodeRef3,
            op: RaftInputOperation.Put,
            key: "foo",
            value: stateRef3.keyValuePairs.foo,
        };
        lastState = stateRef3;
        await unaryCall("propose", ts, client2, inputRef3, lastState);
        await Promise.allSettled([
            unaryCall("getState", ts, client1, nodeRef1, lastState),
            unaryCall("getState", ts, client1, nodeRef2, lastState),
            unaryCall("getState", ts, client2, nodeRef3, lastState),
        ]);
    });

    await t.test("propose foo with null_value", async ts => {
        const inputRefNull: RaftInput = {
            ref: nodeRef3,
            op: RaftInputOperation.Put,
            key: "foo",
            value: stateRefNullValue.keyValuePairs.foo,
        };
        lastState = stateRefNullValue;
        await unaryCall("propose", ts, client2, inputRefNull, lastState);
        await Promise.allSettled([
            unaryCall("getState", ts, client1, nodeRef1, lastState),
            unaryCall("getState", ts, client1, nodeRef2, lastState),
            unaryCall("getState", ts, client2, nodeRef3, lastState),
        ]);
    });

    await t.test("propose Put input without value", async ts => {
        const inputRefNoValue: RaftInput = { ref: nodeRef3, op: RaftInputOperation.Put, key: "foo" };
        lastState = stateRefNullValue;
        await unaryCall("propose", ts, client2, inputRefNoValue, lastState);
        await Promise.allSettled([
            unaryCall("getState", ts, client1, nodeRef1, lastState),
            unaryCall("getState", ts, client1, nodeRef2, lastState),
            unaryCall("getState", ts, client2, nodeRef3, lastState),
        ]);
    });

    await t.test("propose Put input with null value", async ts => {
        const inputRefNull: RaftInput = {
            ref: nodeRef3,
            op: RaftInputOperation.Put,
            key: "foo",
            value: stateRefNoValue.keyValuePairs.foo,
        };
        lastState = stateRefNullValue;
        await unaryCall("propose", ts, client2, inputRefNull, lastState);
        await Promise.allSettled([
            unaryCall("getState", ts, client1, nodeRef1, lastState),
            unaryCall("getState", ts, client1, nodeRef2, lastState),
            unaryCall("getState", ts, client2, nodeRef3, lastState),
        ]);
    });

    await t.test("propose foo with invalid value key", async ts => {
        const inputRefInvalid: RaftInput = {
            ref: nodeRef3,
            op: RaftInputOperation.Put,
            key: "foo",

            // Invalid value key "fooValue" for type google.protobuf.Value is
            // removed, resulting in an invalid empty object that is rejected
            // by TNC consensus controller.
            value: { fooValue: 42 },
        };
        const errorInternal = { code: StatusCode.INTERNAL, details: "*" };
        await unaryCall("propose", ts, client2, inputRefInvalid, undefined, errorInternal);
        await Promise.allSettled([
            unaryCall("getState", ts, client1, nodeRef1, lastState),
            unaryCall("getState", ts, client1, nodeRef2, lastState),
            unaryCall("getState", ts, client2, nodeRef3, lastState),
        ]);
    });

    await t.test("propose foo with invalid value format", async ts => {
        const inputRefInvalid: RaftInput = {
            ref: nodeRef3,
            op: RaftInputOperation.Put,
            key: "foo",

            // Not a valid value for type google.protobuf.Value type. Results in
            // a request message serialization failure.
            value: 42,
        };
        const errorInternal = { code: StatusCode.INTERNAL, details: "*" };
        await unaryCall("propose", ts, client2, inputRefInvalid, undefined, errorInternal);
        await Promise.allSettled([
            unaryCall("getState", ts, client1, nodeRef1, lastState),
            unaryCall("getState", ts, client1, nodeRef2, lastState),
            unaryCall("getState", ts, client2, nodeRef3, lastState),
        ]);
    });

    await t.test("complete observing state while proposing", async ts => {
        completionSubjectObserveState.complete();
        await observeStatePromise;
    });

    await t.test("stop and reconnect 2 Raft nodes", async ts => {
        // Note that a stopped Raft node is still member of the Raft cluster.
        const idsAfterStop = new Set([nodeRef1.id, nodeRef2.id, nodeRef3.id]);
        const configAfterStop = (r: RaftClusterConfiguration) => ts.strictSame(new Set(r.ids), idsAfterStop);
        const errorNotConnected = { code: StatusCode.UNAVAILABLE, details: "Raft node is currently not connected" };
        await unaryCall("stop", ts, client1, nodeRef1, {});
        await Promise.allSettled([
            unaryCall("getClusterConfiguration", ts, client1, nodeRef1, undefined, errorNotConnected),
            unaryCall("getClusterConfiguration", ts, client1, nodeRef2, configAfterStop),
            unaryCall("getClusterConfiguration", ts, client2, nodeRef3, configAfterStop),
            unaryCall("getState", ts, client1, nodeRef1, undefined, errorNotConnected),
        ]);

        const inputRef2: RaftInput = { ref: nodeRef2, op: RaftInputOperation.Put, key: "foo", value: { numberValue: 43 } };
        lastState = { keyValuePairs: { [inputRef2.key]: inputRef2.value } };
        await unaryCall("propose", ts, client1, inputRef2, lastState);
        await Promise.allSettled([
            unaryCall("getState", ts, client1, nodeRef2, lastState),
            unaryCall("getState", ts, client2, nodeRef3, lastState),
        ]);

        // After stopping the second node the cluster cannot make progress anymore
        // (because of missing majority) until a stopped node reconnects. For this
        // reason, propose, getState, and getClusterConfiguration calls on the
        // connected node won't emit a result until reconnect.
        await unaryCall("stop", ts, client1, nodeRef2, {});
        const shouldNotEmitResultWithinMillis = 1000;
        await Promise.allSettled([
            unaryCall("getClusterConfiguration", ts, client1, nodeRef1, undefined, errorNotConnected),
            unaryCall("getClusterConfiguration", ts, client1, nodeRef2, undefined, errorNotConnected),
            unaryCall("getClusterConfiguration", ts, client2, nodeRef3, shouldNotEmitResultWithinMillis),
            unaryCall("getState", ts, client1, nodeRef1, undefined, errorNotConnected),
            unaryCall("getState", ts, client1, nodeRef2, undefined, errorNotConnected),
            unaryCall("getState", ts, client2, nodeRef3, shouldNotEmitResultWithinMillis),
        ]);

        const inputRef3: RaftInput = { ref: nodeRef3, op: RaftInputOperation.Put, key: "foo", value: { numberValue: 44 } };
        lastState = { keyValuePairs: { [inputRef3.key]: inputRef3.value } };
        const pendingCalls = [
            unaryCall("propose", ts, client2, inputRef3, lastState),
            unaryCall("getClusterConfiguration", ts, client2, nodeRef3, configAfterStop),
            unaryCall("getState", ts, client2, nodeRef3, lastState),
        ];

        await Promise.allSettled([
            unaryCall("connect", ts, client1, nodeRef1, {}),
            unaryCall("connect", ts, client1, nodeRef2, {}),
        ]);
        for (const call of pendingCalls) {
            await call;
        }
        await Promise.allSettled([
            unaryCall("getClusterConfiguration", ts, client1, nodeRef1, configAfterStop),
            unaryCall("getClusterConfiguration", ts, client1, nodeRef2, configAfterStop),
            unaryCall("getState", ts, client1, nodeRef1, lastState),
            unaryCall("getState", ts, client1, nodeRef2, lastState),
        ]);
    });

    await t.test("issue operations with invalid Raft node ref", async ts => {
        const undefinedId = { id: "e1f00817-62eb-45aa-8526-bb5ed1fbaea3" };
        const undefinedRaftNodeIdError = { code: StatusCode.INVALID_ARGUMENT, details: "Raft node with this id has not been created" };
        await Promise.allSettled([
            unaryCall("connect", ts, client1, undefinedId, undefined, undefinedRaftNodeIdError),
            unaryCall("disconnect", ts, client1, undefinedId, undefined, undefinedRaftNodeIdError),
            unaryCall("stop", ts, client1, undefinedId, undefined, undefinedRaftNodeIdError),
            unaryCall("propose", ts, client1, undefinedId, undefined, undefinedRaftNodeIdError),
            unaryCall("getState", ts, client1, undefinedId, undefined, undefinedRaftNodeIdError),
            unaryCall("getClusterConfiguration", ts, client1, undefinedId, undefined, undefinedRaftNodeIdError),
            streamingCall("observeState", ts, client1, undefinedId, [], undefined, undefinedRaftNodeIdError),
            streamingCall("observeClusterConfiguration", ts, client1, undefinedId, [], undefined, undefinedRaftNodeIdError),
        ]);
    });

    await t.test("disconnect Raft nodes one at a time", async ts => {
        let idsAfterDisconnect = new Set([nodeRef2.id, nodeRef3.id]);
        const configAfterDisconnect = (r: RaftClusterConfiguration) => ts.strictSame(new Set(r.ids), idsAfterDisconnect);
        const errorNotConnected = { code: StatusCode.UNAVAILABLE, details: "Raft node is currently not connected" };

        // Note that cluster changes are only emitted when a node disconnects. This streaming call
        // is ended by server and the promise resolved once the associated Raft node is disconnected.
        streamingCall("observeClusterConfiguration", ts, client2, nodeRef3, [
            found => testClusterConfiguration(found, { ids: [nodeRef2.id, nodeRef3.id] }),
            found => testClusterConfiguration(found, { ids: [nodeRef3.id] }),
            found => testClusterConfiguration(found, { ids: [] }),
        ], undefined, undefined, true);

        await unaryCall("disconnect", ts, client1, nodeRef1, {});
        await Promise.allSettled([
            unaryCall("getClusterConfiguration", ts, client1, nodeRef1, undefined, errorNotConnected),
            unaryCall("getClusterConfiguration", ts, client1, nodeRef2, configAfterDisconnect),
            unaryCall("getClusterConfiguration", ts, client2, nodeRef3, configAfterDisconnect),
        ]);
        idsAfterDisconnect = new Set([nodeRef3.id]);
        await unaryCall("disconnect", ts, client1, nodeRef2, {});
        await Promise.allSettled([
            unaryCall("getClusterConfiguration", ts, client1, nodeRef1, undefined, errorNotConnected),
            unaryCall("getClusterConfiguration", ts, client1, nodeRef2, undefined, errorNotConnected),
            unaryCall("getClusterConfiguration", ts, client2, nodeRef3, configAfterDisconnect),
        ]);
        await unaryCall("disconnect", ts, client2, nodeRef3, {});
        await Promise.allSettled([
            unaryCall("getClusterConfiguration", ts, client1, nodeRef1, undefined, errorNotConnected),
            unaryCall("getClusterConfiguration", ts, client1, nodeRef2, undefined, errorNotConnected),
            unaryCall("getClusterConfiguration", ts, client2, nodeRef3, undefined, errorNotConnected),
            streamingCall("observeClusterConfiguration", ts, client1, nodeRef1, [], undefined, errorNotConnected),
            streamingCall("observeClusterConfiguration", ts, client1, nodeRef2, [], undefined, errorNotConnected),
            streamingCall("observeClusterConfiguration", ts, client2, nodeRef3, [], undefined, errorNotConnected),
            streamingCall("observeState", ts, client1, nodeRef1, [], undefined, errorNotConnected),
            streamingCall("observeState", ts, client1, nodeRef2, [], undefined, errorNotConnected),
            streamingCall("observeState", ts, client2, nodeRef3, [], undefined, errorNotConnected),
        ]);
    });

    await t.test("issue operations with fail fast enabled and Coaty communication offline", async ts => {
        // Disconnect from Coaty network to ensure fail fast behavior is triggered
        // for subsequent operations.
        await tnc1.coatyAgent.communicationManager.stop();

        const errorUnavailable = { code: StatusCode.UNAVAILABLE, details: "Coaty agent is offline" };

        await unaryCall("connect", ts, client1, nodeRef1, undefined, errorUnavailable);
        await unaryCall("disconnect", ts, client1, nodeRef1, undefined, errorUnavailable);
        await unaryCall("stop", ts, client1, nodeRef1, undefined, errorUnavailable);
        await unaryCall("getState", ts, client1, nodeRef1, undefined, errorUnavailable);
        await unaryCall("getClusterConfiguration", ts, client1, nodeRef1, undefined, errorUnavailable);
        await streamingCall("observeClusterConfiguration", ts, client1, nodeRef1, [], undefined, errorUnavailable);
        await streamingCall("observeState", ts, client1, nodeRef1, [], undefined, errorUnavailable);
    });

    // This should always be the final test for any started TnConnector instance.
    await t.test("stop TNCs", async ts => {
        const db1 = tnc1.coatyAgent.runtime.databaseOptions["raftStore"].connectionString;
        const db2 = tnc2.coatyAgent.runtime.databaseOptions["raftStore"].connectionString;
        ts.teardown(() => tnc1.stop());
        ts.teardown(() => tnc2.stop());
        ts.teardown(() => fse.unlinkSync(db1));
        ts.teardown(() => fse.unlinkSync(db2));
    });
});
