/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

import {
    ServerWritableStream,
    UntypedServiceImplementation,
} from "@grpc/grpc-js";
import Debug from "debug";

import { TnConnectorOptions } from "../common/tn-connector";
import { TnLifecycleController } from "../controller/tn-lifecycle-controller";
import { TnBaseService } from "./tn-base-service";

/**
 * TS type definition of Protobuf message type AgentSelector.
 */
export type AgentSelector =
    | { identityName?: string | RegExp; identityId?: never | undefined }
    | { identityId?: string; identityName?: never | undefined }
    ;

/**
 * TS type definition of Protobuf message type AgentLifecycleEvent.
 */
export interface AgentLifecycleEvent {
    identity: { name: string, id: string, local?: boolean };
    state: AgentLifecycleState;
}

/**
 * TS type definition of Protobuf enum type AgentLifecycleState.
 */
export enum AgentLifecycleState {
    Unspecified = 0,
    Join = 1,
    Leave = 2,
}

type TrackAgentsCall = ServerWritableStream<AgentSelector, AgentLifecycleEvent>;

/**
 * Defines request handlers and logic of gRPC service for Transaction Network
 * Lifecycle Interface.
 */
export class TnLifecycleService extends TnBaseService<TnLifecycleController> {

    constructor(
        getTnController: () => TnLifecycleController,
        getTnConnectorOptions: () => Readonly<Required<TnConnectorOptions>>,
        isCoatyAgentOnline: () => boolean,
        debug: Debug.Debugger) {
        super(getTnController, getTnConnectorOptions, isCoatyAgentOnline, debug, "TnLifecycleService");
    }

    get handlers(): UntypedServiceImplementation {
        return {
            trackAgents: (call: TrackAgentsCall) => this._trackAgents(call),
        };
    }

    private _trackAgents(call: TrackAgentsCall) {
        this.handleServerStreamingCall(call, "trackAgents", evt => call.write(evt));
    }
}
