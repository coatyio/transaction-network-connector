/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

import {
    sendUnaryData,
    ServerUnaryCall,
    ServerWritableStream,
    status as StatusCode,
    UntypedServiceImplementation,
} from "@grpc/grpc-js";
import Debug from "debug";

import { TnConnectorOptions } from "../common/tn-connector";
import { RaftError, TnConsensusController } from "../controller/tn-consensus-controller";
import { TnBaseService } from "./tn-base-service";

/**
 * TS type definition of Protobuf message type RaftNodeCreateOptions.
 */
export interface RaftNodeCreateOptions {
    cluster?: string;
    shouldCreateCluster?: boolean;
}

/**
 * TS type definition of Protobuf message type RaftNodeRef.
 */
export interface RaftNodeRef {
    id: string;
}

/**
 * TS type definition of Protobuf message type RaftAck.
 */
export type RaftAck = {};

/**
 * TS type definition of Protobuf message type RaftInput.
 */
export interface RaftInput {
    ref: RaftNodeRef;
    op: RaftInputOperation;
    key: string;
    value?: any;
}

/**
 * TS type definition of Protobuf enum type RaftInputOperation.
 */
export enum RaftInputOperation {
    Unspecified = 0,
    Put = 1,
    Delete = 2,
}

/**
 * TS type definition of Protobuf message type RaftState.
 */
export interface RaftState {
    keyValuePairs: { [key: string]: any };
}

/**
 * TS type definition of Protobuf message type RaftClusterConfiguration.
 */
export interface RaftClusterConfiguration {
    ids: string[];
}

type CreateCall = ServerUnaryCall<RaftNodeCreateOptions, RaftNodeRef>;
type ConnectCall = ServerUnaryCall<RaftNodeRef, RaftAck>;
type DisconnectCall = ServerUnaryCall<RaftNodeRef, RaftAck>;
type StopCall = ServerUnaryCall<RaftNodeRef, RaftAck>;
type ProposeCall = ServerUnaryCall<RaftInput, RaftState>;
type GetStateCall = ServerUnaryCall<RaftNodeRef, RaftState>;
type ObserveStateCall = ServerWritableStream<RaftNodeRef, RaftState>;
type GetClusterConfigurationCall = ServerUnaryCall<RaftNodeRef, RaftClusterConfiguration>;
type ObserveClusterConfigurationCall = ServerWritableStream<RaftNodeRef, RaftClusterConfiguration>;

/**
 * Defines request handlers and logic of gRPC service for Transaction Network
 * Consensus Interface.
 */
export class TnConsensusService extends TnBaseService<TnConsensusController> {

    constructor(
        getTnController: () => TnConsensusController,
        getTnConnectorOptions: () => Readonly<Required<TnConnectorOptions>>,
        isCoatyAgentOnline: () => boolean,
        debug: Debug.Debugger) {
        super(getTnController, getTnConnectorOptions, isCoatyAgentOnline, debug, "TnConsensusService");
    }

    get handlers(): UntypedServiceImplementation {
        return {
            create: (call: CreateCall, callback: sendUnaryData<RaftNodeRef>) => this._create(call, callback),
            connect: (call: ConnectCall, callback: sendUnaryData<RaftAck>) => this._connect(call, callback),
            disconnect: (call: DisconnectCall, callback: sendUnaryData<RaftAck>) => this._disconnect(call, callback),
            stop: (call: StopCall, callback: sendUnaryData<RaftAck>) => this._stop(call, callback),
            propose: (call: ProposeCall, callback: sendUnaryData<RaftState>) => this._propose(call, callback),
            getState: (call: GetStateCall, callback: sendUnaryData<RaftState>) => this._getState(call, callback),
            observeState: (call: ObserveStateCall) => this._observeState(call),
            getClusterConfiguration:
                (call: GetClusterConfigurationCall, callback: sendUnaryData<RaftClusterConfiguration>) =>
                    this._getClusterConfiguration(call, callback),
            observeClusterConfiguration: (call: ObserveClusterConfigurationCall) => this._observeClusterConfiguration(call),
        };
    }

    private async _create(call: CreateCall, callback: sendUnaryData<RaftNodeRef>) {
        callback(null, this.getTnController().create(call.request));
    }

    private async _connect(call: ConnectCall, callback: sendUnaryData<RaftAck>) {
        if (this.failFastIfOffline) {
            const errorMsg = "Coaty agent is offline";
            this.debug("Connect failed: %s", errorMsg);
            callback({ code: StatusCode.UNAVAILABLE, details: errorMsg });
            return;
        }
        switch (await this.getTnController().connect(call.request)) {
            case RaftError.None:
                callback(null, {});
                break;
            case RaftError.UndefinedRaftNodeId: {
                const msg = "Raft node with this id has not been created";
                this.debug("Connect failed: %s", msg);
                callback({ code: StatusCode.INVALID_ARGUMENT, details: msg });
                break;
            }
            case RaftError.OperationNotSupportedInCurrentConnectionState: {
                const msg = "Raft node is currently disconnecting or stopping";
                this.debug("Connect failed: %s", msg);
                callback({ code: StatusCode.UNAVAILABLE, details: msg });
                break;
            }
        }
    }

    private async _disconnect(call: DisconnectCall, callback: sendUnaryData<RaftAck>) {
        if (this.failFastIfOffline) {
            const errorMsg = "Coaty agent is offline";
            this.debug("Disconnect failed: %s", errorMsg);
            callback({ code: StatusCode.UNAVAILABLE, details: errorMsg });
            return;
        }
        switch (await this.getTnController().disconnect(call.request)) {
            case RaftError.None:
                callback(null, {});
                break;
            case RaftError.UndefinedRaftNodeId: {
                const msg = "Raft node with this id has not been created";
                this.debug("Disconnect failed: %s", msg);
                callback({ code: StatusCode.INVALID_ARGUMENT, details: msg });
                break;
            }
            case RaftError.OperationNotSupportedInCurrentConnectionState: {
                const msg = "Raft node is currently connecting or stopping";
                this.debug("Disconnect failed: %s", msg);
                callback({ code: StatusCode.UNAVAILABLE, details: msg });
                break;
            }
        }
    }

    private async _stop(call: StopCall, callback: sendUnaryData<RaftAck>) {
        if (this.failFastIfOffline) {
            const errorMsg = "Coaty agent is offline";
            this.debug("Stop failed: %s", errorMsg);
            callback({ code: StatusCode.UNAVAILABLE, details: errorMsg });
            return;
        }
        switch (await this.getTnController().stop(call.request)) {
            case RaftError.None:
                callback(null, {});
                break;
            case RaftError.UndefinedRaftNodeId: {
                const msg = "Raft node with this id has not been created";
                this.debug("Stop failed: %s", msg);
                callback({ code: StatusCode.INVALID_ARGUMENT, details: msg });
                break;
            }
            case RaftError.OperationNotSupportedInCurrentConnectionState: {
                const msg = "Raft node is currently connecting or disconnecting";
                this.debug("Stop failed: %s", msg);
                callback({ code: StatusCode.UNAVAILABLE, details: msg });
                break;
            }
        }
    }

    private async _propose(call: ProposeCall, callback: sendUnaryData<RaftState>) {
        if (this.failFastIfOffline) {
            const errorMsg = "Coaty agent is offline";
            this.debug("Propose failed: %s", errorMsg);
            callback({ code: StatusCode.UNAVAILABLE, details: errorMsg });
            return;
        }
        const stateOrError = await this.getTnController().propose(call.request);
        if (typeof stateOrError === "number") {
            switch (stateOrError) {
                case RaftError.UndefinedRaftNodeId: {
                    const msg = "Raft node with this id has not been created";
                    this.debug("Propose failed: %s", msg);
                    callback({ code: StatusCode.INVALID_ARGUMENT, details: msg });
                    break;
                }
                case RaftError.TooManyQueuedUpInputProposals: {
                    const msg = "Too many queued up input proposals for this Raft node";
                    this.debug("Propose failed: %s", msg);
                    callback({ code: StatusCode.OUT_OF_RANGE, details: msg });
                    break;
                }
                case RaftError.OperationNotSupportedInCurrentConnectionState: {
                    const msg = "Raft node is currently not connected";
                    this.debug("Propose failed: %s", msg);
                    callback({ code: StatusCode.UNAVAILABLE, details: msg });
                    break;
                }
                case RaftError.DisconnectBeforeOperationComplete: {
                    const msg = "Raft node stopped or disconnected before proposal committed";
                    this.debug("Propose failed: %s", msg);
                    callback({ code: StatusCode.UNAVAILABLE, details: msg });
                    break;
                }
                case RaftError.Internal: {
                    const msg = "Serialization format of input value may be invalid";
                    this.debug("Propose failed: %s", msg);
                    callback({ code: StatusCode.INTERNAL, details: msg });
                    break;
                }
            }
        } else {
            callback(null, stateOrError);
        }
    }

    private async _getState(call: GetStateCall, callback: sendUnaryData<RaftState>) {
        if (this.failFastIfOffline) {
            const errorMsg = "Coaty agent is offline";
            this.debug("GetState failed: %s", errorMsg);
            callback({ code: StatusCode.UNAVAILABLE, details: errorMsg });
            return;
        }
        const stateOrError = await this.getTnController().getState(call.request);
        if (typeof stateOrError === "number") {
            switch (stateOrError) {
                case RaftError.UndefinedRaftNodeId: {
                    const msg = "Raft node with this id has not been created";
                    this.debug("GetState failed: %s", msg);
                    callback({ code: StatusCode.INVALID_ARGUMENT, details: msg });
                    break;
                }
                case RaftError.OperationNotSupportedInCurrentConnectionState: {
                    const msg = "Raft node is currently not connected";
                    this.debug("GetState failed: %s", msg);
                    callback({ code: StatusCode.UNAVAILABLE, details: msg });
                    break;
                }
                case RaftError.DisconnectBeforeOperationComplete: {
                    const msg = "Raft node stopped or disconnected before state could be retrieved";
                    this.debug("GetState failed: %s", msg);
                    callback({ code: StatusCode.UNAVAILABLE, details: msg });
                    break;
                }
                case RaftError.Internal: {
                    const msg = "Unexpected error";
                    this.debug("GetState failed: %s", msg);
                    callback({ code: StatusCode.INTERNAL, details: msg });
                    break;
                }
            }
        } else {
            callback(null, stateOrError);
        }
    }

    private async _observeState(call: ObserveStateCall) {
        this.handleServerStreamingCall(call, "observeState", evt => call.write(evt));
    }

    private async _getClusterConfiguration(call: GetClusterConfigurationCall, callback: sendUnaryData<RaftClusterConfiguration>) {
        if (this.failFastIfOffline) {
            const errorMsg = "Coaty agent is offline";
            this.debug("GetClusterConfiguration failed: %s", errorMsg);
            callback({ code: StatusCode.UNAVAILABLE, details: errorMsg });
            return;
        }
        const stateOrError = await this.getTnController().getClusterConfiguration(call.request);
        if (typeof stateOrError === "number") {
            switch (stateOrError) {
                case RaftError.UndefinedRaftNodeId: {
                    const msg = "Raft node with this id has not been created";
                    this.debug("GetClusterConfiguration failed: %s", msg);
                    callback({ code: StatusCode.INVALID_ARGUMENT, details: msg });
                    break;
                }
                case RaftError.OperationNotSupportedInCurrentConnectionState: {
                    const msg = "Raft node is currently not connected";
                    this.debug("GetClusterConfiguration failed: %s", msg);
                    callback({ code: StatusCode.UNAVAILABLE, details: msg });
                    break;
                }
                case RaftError.DisconnectBeforeOperationComplete: {
                    const msg = "Raft node stopped or disconnected before state could be retrieved";
                    this.debug("GetClusterConfiguration failed: %s", msg);
                    callback({ code: StatusCode.UNAVAILABLE, details: msg });
                    break;
                }
                case RaftError.Internal: {
                    const msg = "Unexpected error";
                    this.debug("GetClusterConfiguration failed: %s", msg);
                    callback({ code: StatusCode.INTERNAL, details: msg });
                    break;
                }
            }
        } else {
            callback(null, stateOrError);
        }
    }

    private async _observeClusterConfiguration(call: ObserveClusterConfigurationCall) {
        this.handleServerStreamingCall(call, "observeClusterConfiguration", evt => call.write(evt));
    }
}
