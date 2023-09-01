/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

import {
    DisconnectBeforeOperationCompleteError,
    OperationNotSupportedInCurrentConnectionStateError,
    RaftController,
    RaftControllerOptions,
    RaftStateMachine,
    TooManyQueuedUpInputProposalsError,
} from "@coaty/consensus.raft";
import { Uuid } from "@coaty/core";
import { Observable } from "rxjs";
import { map, takeUntil } from "rxjs/operators";
import { UnavailableError } from "../service/tn-base-service";

import { RaftClusterConfiguration, RaftInput, RaftInputOperation, RaftNodeCreateOptions, RaftNodeRef, RaftState } from "../service/tn-consensus-service";
import { TnBaseController } from "./tn-base-controller";

/**
 * Transforms gRPC client calls into Raft over Coaty protocol invocations.
 */
export class TnConsensusController extends TnBaseController {

    // As Raft node Ids are UUIDs there is no need to index by cluster.
    private _raftControllers = new Map<Uuid, RaftController>();

    async onServiceStopping(): Promise<void> {
        // Do not delete database file as it may be used by other running TN
        // Connector instances. State data for the Raft nodes that are shut down
        // is being cleared by disconnect.
        await Promise.allSettled(Array.from(this._raftControllers.values()).map(rc => this.disconnect({ id: rc.options.id })));
    }

    create(createOptions: RaftNodeCreateOptions): RaftNodeRef {
        const id = this.runtime.newUuid();
        const options: RaftControllerOptions = {
            id,
            cluster: createOptions.cluster ?? "",
            stateMachine: new KVRaftStateMachine(),
            shouldCreateCluster: !!createOptions.shouldCreateCluster,
            databaseKey: "raftStore",
        };
        const ctrl = this.container.registerController<RaftController>("RaftController" + id, RaftController, options);
        this._raftControllers.set(id, ctrl);
        return { id };
    }

    async connect(nodeRef: RaftNodeRef): Promise<RaftError> {
        const ctrl = this._raftControllers.get(nodeRef.id);
        if (ctrl === undefined) {
            return RaftError.UndefinedRaftNodeId;
        }
        try {
            await ctrl.connect();
            return RaftError.None;
        } catch (error) {
            return RaftError.OperationNotSupportedInCurrentConnectionState;
        }
    }

    async disconnect(nodeRef: RaftNodeRef): Promise<RaftError> {
        const ctrl = this._raftControllers.get(nodeRef.id);
        if (ctrl === undefined) {
            return RaftError.UndefinedRaftNodeId;
        }
        try {
            await ctrl.disconnect();
            return RaftError.None;
        } catch (error) {
            return RaftError.OperationNotSupportedInCurrentConnectionState;
        }
    }

    async stop(nodeRef: RaftNodeRef): Promise<RaftError> {
        const ctrl = this._raftControllers.get(nodeRef.id);
        if (ctrl === undefined) {
            return RaftError.UndefinedRaftNodeId;
        }
        try {
            await ctrl.stop();
            return RaftError.None;
        } catch (error) {
            return RaftError.OperationNotSupportedInCurrentConnectionState;
        }
    }

    async propose(input: RaftInput): Promise<RaftState | RaftError> {
        const ctrl = this._raftControllers.get(input.ref?.id);
        if (ctrl === undefined) {
            return RaftError.UndefinedRaftNodeId;
        }
        try {
            if (input.value === null) {
                // If no input value is given, use null_value of google.protobuf.Value type.
                input.value = { nullValue: 0 };
            }
            let isEmptyObject = true;
            // tslint:disable-next-line: forin
            for (const _key in input.value) {
                isEmptyObject = false;
                break;
            }
            if (isEmptyObject) {
                this.debug("Proposed input rejected: value is not of type google.protobuf.Value");
                return RaftError.Internal;
            }
            return { keyValuePairs: Object.fromEntries(await ctrl.propose(input)) };
        } catch (error) {
            if (error instanceof TooManyQueuedUpInputProposalsError) {
                return RaftError.TooManyQueuedUpInputProposals;
            }
            if (error instanceof DisconnectBeforeOperationCompleteError) {
                return RaftError.DisconnectBeforeOperationComplete;
            }
            if (error instanceof OperationNotSupportedInCurrentConnectionStateError) {
                return RaftError.OperationNotSupportedInCurrentConnectionState;
            }
            return RaftError.Internal;
        }
    }

    async getState(nodeRef: RaftNodeRef): Promise<RaftState | RaftError> {
        const ctrl = this._raftControllers.get(nodeRef.id);
        if (ctrl === undefined) {
            return RaftError.UndefinedRaftNodeId;
        }
        try {
            return { keyValuePairs: Object.fromEntries(await ctrl.getState()) };
        } catch (error) {
            if (error instanceof DisconnectBeforeOperationCompleteError) {
                return RaftError.DisconnectBeforeOperationComplete;
            }
            if (error instanceof OperationNotSupportedInCurrentConnectionStateError) {
                return RaftError.OperationNotSupportedInCurrentConnectionState;
            }
            return RaftError.Internal;
        }
    }

    observeState(nodeRef: RaftNodeRef, onCancelled$: Observable<unknown>): Observable<RaftState> {
        const ctrl = this._raftControllers.get(nodeRef.id);
        if (ctrl === undefined) {
            throw new Error("Raft node with this id has not been created");
        }
        try {
            return ctrl.observeState()
                .pipe(
                    takeUntil(onCancelled$),
                    map(state => ({ keyValuePairs: Object.fromEntries(state) })),
                );
        } catch (error) {
            throw new UnavailableError("Raft node is currently not connected");
        }
    }

    async getClusterConfiguration(nodeRef: RaftNodeRef): Promise<RaftClusterConfiguration | RaftError> {
        const ctrl = this._raftControllers.get(nodeRef.id);
        if (ctrl === undefined) {
            return RaftError.UndefinedRaftNodeId;
        }
        try {
            return {
                ids: (await ctrl.getClusterConfiguration()),
            };
        } catch (error) {
            if (error instanceof DisconnectBeforeOperationCompleteError) {
                return RaftError.DisconnectBeforeOperationComplete;
            }
            if (error instanceof OperationNotSupportedInCurrentConnectionStateError) {
                return RaftError.OperationNotSupportedInCurrentConnectionState;
            }
            return RaftError.Internal;
        }
    }

    observeClusterConfiguration(nodeRef: RaftNodeRef, onCancelled$: Observable<unknown>): Observable<RaftClusterConfiguration> {
        const ctrl = this._raftControllers.get(nodeRef.id);
        if (ctrl === undefined) {
            throw new Error("Raft node with this id has not been created");
        }
        try {
            return ctrl.observeClusterConfiguration()
                .pipe(
                    takeUntil(onCancelled$),
                    map(ids => ({ ids })),
                );
        } catch (error) {
            throw new UnavailableError("Raft node is currently not connected");
        }
    }
}

export enum RaftError {
    None,
    Internal,
    DisconnectBeforeOperationComplete,
    OperationNotSupportedInCurrentConnectionState,
    TooManyQueuedUpInputProposals,
    UndefinedRaftNodeId,
}

/**
 * `RaftStateMachine` implementation of a key value store that can process input
 * for `TnConsensusController`.
 *
 * The key values are raw JSON representions of type google.protobuf.Value as
 * received by the gRPC Consensus Service.
 */
export class KVRaftStateMachine implements RaftStateMachine {
    private _state = new Map<string, any>();

    processInput(input: RaftInput) {
        switch (input.op) {
            case RaftInputOperation.Put:
                this._state.set(input.key, input.value);
                break;
            case RaftInputOperation.Delete:
                this._state.delete(input.key);
                break;
            case RaftInputOperation.Unspecified:
            default:
                break;
        }
    }

    getState(): Array<[string, any]> {
        // Convert from Map to JSON compatible object.
        return Array.from(this._state);
    }

    setState(state: Array<[string, any]>): void {
        // Convert from JSON compatible object to Map.
        this._state = new Map(state);
    }
}
