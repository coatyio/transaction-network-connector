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
import { TnBaseController } from "../controller/tn-base-controller";
import { TnBaseService } from "./tn-base-service";

/**
 * TS type definition of Protobuf message type PushRoute.
 */
export interface PushRoute {
    route: string;
}

/**
 * TS type definition of Protobuf message type RequestRoute.
 */
export interface RequestRoute {
    route: string;
    routingPolicy?: RoutingPolicy;
}

/**
 * TS type definition of Protobuf enum type RoutingPolicy.
 */
export enum RoutingPolicy {
    Single = 0,
    First = 1,
    Last = 2,
    Next = 3,
    Random = 4,
}

/**
 * TS type definition of Protobuf message type RouteEventAck.
 */
export interface RouteEventAck {
    routingCount: number;
}


/**
 * TS type definition of Protobuf message type PushEvent.
 */
export interface PushEvent {
    route: string;
    data?: AnyType;
}

/**
 * TS type definition of Protobuf message type RequestEvent.
 */
export interface RequestEvent {
    route: string;
    requestId?: number;
    data?: AnyType;
}

/**
 * TS type definition of Protobuf message type ResponseEvent.
 */
export interface ResponseEvent {
    route: string;
    requestId?: number;
    data?: AnyType;
    error?: string;
}

type RegistrationCall = ServerWritableStream<PushRoute | RequestRoute, PushEvent | RequestEvent>;
type PushCall = ServerUnaryCall<PushEvent, RouteEventAck>;
type RequestCall = ServerUnaryCall<RequestEvent, ResponseEvent>;
type RespondCall = ServerUnaryCall<ResponseEvent, RouteEventAck>;

type RegistrationCallTwoWayItems = {
    calls: RegistrationCall[],
    requestId: number;
    policy: RoutingPolicy,
    selector: (calls: RegistrationCall[]) => RegistrationCall,
};
type RequestCallItem = [call: RequestCall, callback: sendUnaryData<ResponseEvent>, registrationCall: RegistrationCall];

/**
 * Defines request handlers and logic of gRPC Routing Service for FlowPro
 * Intercomponent Communication.
 */
export class RoutingService extends TnBaseService<TnBaseController> {

    readonly debug: Debug.Debugger;

    // Maps a one-way route identifier to associated registration calls.
    private readonly _registrationCallsOneWay: Map<string, RegistrationCall[]>;

    // Maps a two-way route identifier to associated registration calls.
    private readonly _registrationCallsTwoWay: Map<string, RegistrationCallTwoWayItems>;

    // Maps a two-way route identifier to pending request calls with correlated
    // registration calls mapped by request IDs.
    private readonly _requestCalls: Map<string, Map<number, RequestCallItem>>;

    constructor(debug: Debug.Debugger) {
        super(() => undefined, () => undefined, () => undefined, debug, "RoutingService");
        this._registrationCallsOneWay = new Map();
        this._registrationCallsTwoWay = new Map();
        this._requestCalls = new Map();
    }

    get handlers(): UntypedServiceImplementation {
        return {
            registerPushRoute: (call: RegistrationCall) => this._handleRegister(call, false),
            registerRequestRoute: (call: RegistrationCall) => this._handleRegister(call, true),
            push: (call: PushCall, cb: sendUnaryData<RouteEventAck>) => this._handlePush(call, cb),
            request: (call: RequestCall, cb: sendUnaryData<ResponseEvent>) => this._handleRequest(call, cb),
            respond: (call: RespondCall, cb: sendUnaryData<RouteEventAck>) => this._handleResponse(call, cb),
        };
    }

    private _handleRegister(call: RegistrationCall, isTwoWayRoute: boolean) {
        try {
            this._registerCall(call, isTwoWayRoute);
        } catch (error) {
            this.debug("%s", error.message);
            call.emit("error", { code: StatusCode.INVALID_ARGUMENT, details: error.message });
            return;
        }

        const onEndOrCancelledOrError = (...args: any[]) => {
            const routeType = isTwoWayRoute ? "two-way" : "one-way";
            if (args[0] instanceof Error) {
                this.debug("Error on registration call for %s route %o: %s", routeType, call.request.route, args[0].message);
            } else {
                this.debug("Registration call cancelled or ended for %s route %o", routeType, call.request.route);
            }
            this._deregisterCall(call, isTwoWayRoute);
        };
        call.once("end", onEndOrCancelledOrError)
            .once("cancelled", onEndOrCancelledOrError)
            .once("error", onEndOrCancelledOrError);
    }

    private _handlePush(call: PushCall, callback: sendUnaryData<RouteEventAck>) {
        const pushEvent = call.request;
        const items = this._registrationCallsOneWay.get(pushEvent.route);
        if (items) {
            for (const item of items) {
                item.write(pushEvent);
            }
        }
        callback(null, { routingCount: items ? items.length : 0 });
    }

    private _handleRequest(call: RequestCall, callback: sendUnaryData<ResponseEvent>) {
        const requestEvent = call.request;
        const items = this._registrationCallsTwoWay.get(requestEvent.route);
        if (items) {
            const registrationCall = items.selector(items.calls);
            const requestId = items.requestId = this._nextRequestId(items.requestId);
            this._addRequestCall(requestEvent.route, requestId, [call, callback, registrationCall]);
            registrationCall.write({ ...requestEvent, requestId });
        } else {
            this.debug("No registration available for request event on route %o", requestEvent.route);
            callback({ code: StatusCode.UNAVAILABLE, details: "No registration available for request event" });
        }
    }

    private _handleResponse(call: RespondCall, callback: sendUnaryData<RouteEventAck>) {
        const response = call.request;
        const requestCallItem = this._removeRequestCall(response.route, response.requestId);
        if (!requestCallItem) {
            this.debug("Response event discarded as it is not correlated with a pending request: %o", response);

            // Ensure respond call fails fast as this case is caused by a programming
            // error on caller's side, either by providing wrong route and/or request ID or
            // by sending a response event after deregistering the associated route.
            callback({
                code: StatusCode.INVALID_ARGUMENT,
                details: "Response event discarded as no correlated registration exits",
            });
            return;
        }
        const [requestCall, requestCb] = requestCallItem;
        if (requestCall.cancelled) {
            this.debug("Response event discarded as request call already cancelled or deadline exceeded: %o", response);

            // Do not emit a gRPC error as caller is not able to avoid this case.
            callback(null, { routingCount: 0 });
            return;
        }
        delete response.requestId;
        requestCb(null, response);
        callback(null, { routingCount: 1 });
    }

    private _nextRequestId(requestId: number) {
        return (requestId < 0xFFFFFFFF) ? requestId + 1 : 1;
    }

    private _routingPolicySelector(policy: RoutingPolicy): (calls: RegistrationCall[]) => RegistrationCall {
        let currentCallIndex = 0;
        switch (policy) {
            case RoutingPolicy.Single:
            case RoutingPolicy.First:
                return calls => calls[0];
            case RoutingPolicy.Last:
                return calls => calls[calls.length - 1];
            case RoutingPolicy.Random:
                return calls => calls[Math.floor(Math.random() * calls.length)];
            case RoutingPolicy.Next:
                return calls => {
                    const next = calls[currentCallIndex];
                    currentCallIndex = currentCallIndex < calls.length - 1 ? currentCallIndex + 1 : 0;
                    return next;
                };
        }
    }

    private _registerCall(call: RegistrationCall, isTwoWayRoute: boolean) {
        if (isTwoWayRoute) {
            const route = call.request as RequestRoute;
            let items = this._registrationCallsTwoWay.get(route.route);
            if (!items) {
                items = {
                    calls: [],
                    requestId: 0,
                    policy: route.routingPolicy,
                    selector: this._routingPolicySelector(route.routingPolicy),
                };
                this._registrationCallsTwoWay.set(route.route, items);
            }
            if (items.policy === RoutingPolicy.Single && items.calls.length > 0) {
                throw new Error(`Registration error on two-way route ${route.route}: additional registrations not allowed with default policy`);
            }
            if (items.policy !== RoutingPolicy.Single && items.policy !== route.routingPolicy) {
                throw new Error(`Registration error on two-way route ${route.route}: additional registration with different policy not accepted`);
            }
            items.calls.push(call);
            if (this.debug.enabled) {
                this.debug("Registered two-way route %o", route);
            }
        } else {
            const route = call.request as PushRoute;
            let calls = this._registrationCallsOneWay.get(route.route);
            if (!calls) {
                calls = [];
                this._registrationCallsOneWay.set(route.route, calls);
            }
            calls.push(call);
            if (this.debug.enabled) {
                this.debug("Registered one-way route %o", route);
            }
        }
    }

    private _deregisterCall(call: RegistrationCall, isTwoWayRoute: boolean) {
        if (isTwoWayRoute) {
            const route = call.request as RequestRoute;
            const items = this._registrationCallsTwoWay.get(route.route);
            if (!items) {
                return;
            }
            const i = items.calls.findIndex(item => item === call);
            if (i !== -1) {
                items.calls.splice(i, 1);
                if (items.calls.length === 0) {
                    this._registrationCallsTwoWay.delete(route.route);
                }

                // Ensure correlated request calls are cancelled if the registration
                // call is deregistered before a response has been send.
                this._cancelRequestCalls(call);
                if (this.debug.enabled) {
                    this.debug("Deregistered two-way route %o", route);
                }
            }
        } else {
            const route = call.request as PushRoute;
            const items = this._registrationCallsOneWay.get(route.route) || [];
            const i = items.findIndex(item => item === call);
            if (i !== -1) {
                items.splice(i, 1);
                if (items.length === 0) {
                    this._registrationCallsOneWay.delete(route.route);
                }
                if (this.debug.enabled) {
                    this.debug("Deregistered one-way route %o", route);
                }
            }
        }
    }

    private _addRequestCall(route: string, requestId: number, item: RequestCallItem) {
        let requestItems = this._requestCalls.get(route);
        if (!requestItems) {
            requestItems = new Map();
            this._requestCalls.set(route, requestItems);
        }
        requestItems.set(requestId, item);
    }

    private _removeRequestCall(route: string, requestId: number): RequestCallItem {
        const items = this._requestCalls.get(route);
        if (!items) {
            return undefined;
        }
        const item = items.get(requestId);
        items.delete(requestId);
        if (items.size === 0) {
            this._requestCalls.delete(route);
        }
        return item;
    }

    private _cancelRequestCalls(call: RegistrationCall) {
        const route = call.request.route;
        const items = this._requestCalls.get(route);
        if (!items) {
            return;
        }
        for (const [requestId, [requestCall, requestCb, registrationCall]] of items) {
            if (registrationCall === call) {
                items.delete(requestId);
                if (items.size === 0) {
                    this._requestCalls.delete(route);
                }
                if (!requestCall.cancelled) {
                    this.debug("Registration on two-way route %o deregistered before response, cancelling request call", route);
                    requestCb({
                        code: StatusCode.CANCELLED,
                        details: "Correlated registration deregistered before response",
                    });
                }
            }
        }
    }
}
