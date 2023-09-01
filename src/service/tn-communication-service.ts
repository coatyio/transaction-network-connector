/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

import {
    sendUnaryData,
    ServerUnaryCall,
    ServerWritableStream,
    status as StatusCode,
    UntypedServiceImplementation,
} from "@grpc/grpc-js";
import Debug from "debug";
import { AnyType } from "../common/grpc-package";

import { CoatyComEnvOptions, TnConnectorOptions } from "../common/tn-connector";
import { TnCommunicationController } from "../controller/tn-communication-controller";
import { TnBaseService } from "./tn-base-service";

/**
 * TS type definition of Protobuf message type CoatyCommunicationOptions.
 */
export interface CoatyCommunicationOptions {
    brokerUrl: string;
    namespace: string;
    userAuth?: {
        username: string;
        password: string;
    };
    tlsAuth?: {
        cert: string;
        key: string;
    };
    notFailFastIfOffline?: boolean;
    agentIdentity?: { name: string, id: string };
}

/**
 * TS type definition of Protobuf message type EventAck.
 */
export type EventAck = {};

/**
 * TS type definition of Protobuf message type ChannelSelector.
 */
export interface ChannelSelector {
    id: string;
}

/**
 * TS type definition of Protobuf message type ChannelEvent.
 */
export interface ChannelEvent {
    id: string;
    data: AnyType;
    sourceId?: string;
}

/**
 * TS type definition of Protobuf message type CallSelector.
 */
export interface CallSelector {
    operation: string;
}

/**
 * TS type definition of Protobuf message type CallEvent.
 */
export interface CallEvent {
    operation: string;
    parameters: AnyType;
    sourceId?: string;
    correlationId?: string;
    responseCallback?: (returnEvt: ReturnEvent) => void;
}

/**
 * TS type definition of Protobuf message type ReturnEvent.
 */
export interface ReturnEvent {
    data?: AnyType;
    error?: ReturnError;
    executionInfo?: AnyType;
    sourceId?: string;
    correlationId?: string;
}

/**
 * TS type definition of Protobuf message type ReturnError.
 */
export interface ReturnError {
    code: number;
    message: string;
}

/**
 * TS type definition of Protobuf message type CompleteEvent.
 */
export interface CompleteEvent {
    correlationId: string;
}

type ConfigureCall = ServerUnaryCall<CoatyCommunicationOptions, EventAck>;
type PublishChannelCall = ServerUnaryCall<ChannelEvent, EventAck>;
type ObserveChannelCall = ServerWritableStream<ChannelSelector, ChannelEvent>;
type PublishCallCall = ServerWritableStream<CallEvent, ReturnEvent>;
type ObserveCallCall = ServerWritableStream<CallSelector, CallEvent>;
type PublishReturnCall = ServerUnaryCall<ReturnEvent, EventAck>;
type PublishCompleteCall = ServerUnaryCall<CompleteEvent, EventAck>;

/**
 * Defines request handlers and logic of gRPC service for Transaction Network
 * Communication Interface.
 */
export class TnCommunicationService extends TnBaseService<TnCommunicationController> {

    // Maps correlation ID of request to a response callback handler.
    private readonly _observedResponseCallbacks: Map<string, (evt: ReturnEvent) => void>;

    constructor(
        getTnController: () => TnCommunicationController,
        getTnConnectorOptions: () => Readonly<Required<TnConnectorOptions>>,
        isCoatyAgentOnline: () => boolean,
        debug: Debug.Debugger,
        private readonly _updateConfiguration: (options: CoatyComEnvOptions) => Promise<void>,
    ) {
        super(getTnController, getTnConnectorOptions, isCoatyAgentOnline, debug, "TnCommunicationService");
        this._observedResponseCallbacks = new Map();
    }

    get handlers(): UntypedServiceImplementation {
        return {
            configure: (call: ConfigureCall, callback: sendUnaryData<EventAck>) => this._configureCoatyCommunication(call, callback),
            publishChannel: (call: PublishChannelCall, callback: sendUnaryData<EventAck>) => this._publishChannel(call, callback),
            observeChannel: (call: ObserveChannelCall) => this._observeChannel(call),
            publishCall: (call: PublishCallCall) => this._publishCall(call),
            observeCall: (call: ObserveCallCall) => this._observeCall(call),
            publishReturn: (call: PublishReturnCall, callback: sendUnaryData<EventAck>) => this._publishReturn(call, callback),
            publishComplete: (call: PublishCompleteCall, callback: sendUnaryData<EventAck>) => this._publishComplete(call, callback),
        };
    }

    private async _configureCoatyCommunication(call: ConfigureCall, callback: sendUnaryData<EventAck>) {
        const serviceOpts = call.request;
        const comOpts: CoatyComEnvOptions = {};
        this.debug("configure CoatyCommunicationOptions: %o", serviceOpts);
        if (serviceOpts.brokerUrl) {
            comOpts.coatyBrokerUrl = serviceOpts.brokerUrl;
        }
        if (serviceOpts.namespace) {
            comOpts.coatyNamespace = serviceOpts.namespace;
        }
        if (serviceOpts.userAuth?.username) {
            comOpts.coatyUsername = serviceOpts.userAuth.username;
        }
        if (serviceOpts.userAuth?.password) {
            comOpts.coatyPassword = serviceOpts.userAuth.password;
        }
        if (serviceOpts.tlsAuth?.cert) {
            comOpts.coatyTlsCert = serviceOpts.tlsAuth.cert;
        }
        if (serviceOpts.tlsAuth?.key) {
            comOpts.coatyTlsKey = serviceOpts.tlsAuth.key;
        }
        // Note that the field notFailFastIfOffline is defined as optional
        // in proto3 to determine whether the field's value has been set.
        if ("notFailFastIfOffline" in serviceOpts) {
            comOpts.coatyFailFastIfOffline = serviceOpts.notFailFastIfOffline ? "false" : "true";
        }
        if (serviceOpts.agentIdentity?.name) {
            comOpts.coatyAgentIdentityName = serviceOpts.agentIdentity.name;
        }
        if (serviceOpts.agentIdentity?.id) {
            comOpts.coatyAgentIdentityId = serviceOpts.agentIdentity.id;
        }

        // Should not throw as server is not yet stopped.
        await this._updateConfiguration(comOpts);
        callback(null, {});
    }

    private _publishChannel(call: PublishChannelCall, callback: sendUnaryData<EventAck>) {
        if (this.failFastIfOffline) {
            const errorMsg = "Coaty agent is offline";
            this.debug("PublishChannel failed: %s", errorMsg);
            callback({ code: StatusCode.UNAVAILABLE, details: errorMsg });
            return;
        }
        try {
            this.getTnController().publishChannel(call.request);
            callback(null, {});
        } catch (error) {
            this.debug("PublishChannel failed: %s", error.message);
            callback({ code: StatusCode.INVALID_ARGUMENT, details: error.message });
        }
    }

    private _observeChannel(call: ObserveChannelCall) {
        this.handleServerStreamingCall(call, "observeChannel", evt => call.write(evt));
    }

    private _publishCall(call: PublishCallCall) {
        this.handleServerStreamingCall(call, "publishCall", evt => call.write(evt));
    }

    private _observeCall(call: ObserveCallCall) {
        this.handleServerStreamingCall(call, "observeCall", evt => {
            this._observedResponseCallbacks.set(evt.correlationId, evt.responseCallback);
            delete evt.responseCallback;
            call.write(evt);
        });
    }

    private _publishReturn(call: PublishReturnCall, callback: sendUnaryData<EventAck>) {
        const responseCallback = this._observedResponseCallbacks.get(call.request.correlationId);
        if (responseCallback === undefined) {
            this.debug("PublishReturn event discarded as it is not correlated with a pending request: %o", call.request);
        } else if (this.failFastIfOffline) {
            const errorMsg = "Coaty agent is offline";
            this.debug("PublishReturn failed: %s", errorMsg);
            callback({ code: StatusCode.UNAVAILABLE, details: errorMsg });
            return;
        } else {
            responseCallback(call.request);
        }
        callback(null, {});
    }

    private _publishComplete(call: PublishCompleteCall, callback: sendUnaryData<EventAck>) {
        this.debug("PublishComplete cleaning up correlated response callback: %o", call.request);
        this._observedResponseCallbacks.delete(call.request.correlationId);
        callback(null, {});
    }
}
