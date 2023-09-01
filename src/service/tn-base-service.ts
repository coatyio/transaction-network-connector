/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

import {
    ServerWritableStream,
    status as StatusCode,
    UntypedServiceImplementation,
} from "@grpc/grpc-js";
import Debug from "debug";
import { Observable, Subject } from "rxjs";

import { TnConnectorOptions } from "../common/tn-connector";
import { TnBaseController } from "../controller/tn-base-controller";

/**
 * Used in server streaming call handler to distinguish between service errors
 * that signal errors with gRPC INVALID_ARGUMENT or UNAVAILABLE status codes.
 */
export class UnavailableError extends Error {

    /**
     * Creates an error that should cause a gRPC UNAVAILABLE error to be
     * signalled.
     *
     * @param message error message
     */
    constructor(message: string) {
        super(message);
        this.name = "UnavailableError";
    }
}

/**
 * Defines common base functionality for request handling and logic of gRPC
 * service for Transaction Network Interfaces.
 */
export abstract class TnBaseService<TC extends TnBaseController> {

    readonly debug: Debug.Debugger;

    constructor(
        protected readonly getTnController: () => TC,
        protected readonly getTnConnectorOptions: () => Readonly<Required<TnConnectorOptions>>,
        protected readonly isCoatyAgentOnline: () => boolean,
        debug: Debug.Debugger,
        debugName: string) {
        this.debug = debug.extend(debugName);
    }

    abstract get handlers(): UntypedServiceImplementation;

    get failFastIfOffline() {
        return !this.isCoatyAgentOnline() && this.getTnConnectorOptions().coatyFailFastIfOffline === "true";
    }

    async onStopping(): Promise<void> {
        await this.getTnController().onServiceStopping();
    }

    protected handleServerStreamingCall<T, O>(
        call: ServerWritableStream<T, O>,
        method: string,
        nextHandler: (evt: O) => void) {
        const onCancelled$ = new Subject();

        if (this.failFastIfOffline) {
            const errorMsg = "Coaty agent is offline";
            this.debug("%s failed: %s", method, errorMsg);
            call.emit("error", { code: StatusCode.UNAVAILABLE, details: errorMsg });
            return;
        }
        try {
            (this.getTnController()[method](call.request, onCancelled$) as Observable<O>)
                .subscribe({
                    next: evt => nextHandler(evt),
                    complete: () => {
                        // In case Coaty communication manager is stopped, end gRPC call.
                        this.debug("%s ending rpc as observable completes", method);
                        call.end();
                    },
                    error: err => {
                        // In case error is emitted on received observable, propagate
                        // error to gRPC streaming server call and end.
                        const statusCode = err instanceof UnavailableError ? StatusCode.UNAVAILABLE : StatusCode.INVALID_ARGUMENT;
                        this.debug("%s error emitted on observable: %s", method, err);
                        call.emit("error", { code: statusCode, details: `${err}` });
                    },
                });
        } catch (error) {
            const statusCode = error instanceof UnavailableError ? StatusCode.UNAVAILABLE : StatusCode.INVALID_ARGUMENT;
            this.debug("%s failed: %s", method, error.message);
            call.emit("error", { code: statusCode, details: error.message });
            return;
        }

        const onEndOrCancelledOrError = (...args: any[]) => {
            if (args[0] instanceof Error) {
                this.debug("Error on %s rpc for call event %o: %s", method, call.request, args[0].message);
            } else {
                this.debug("%s rpc cancelled or ended for call event %o", method, call.request);
            }

            // Unsubscribe associated Coaty observable in case call terminates.
            onCancelled$.next();
        };
        call.once("end", onEndOrCancelledOrError)
            .once("cancelled", onEndOrCancelledOrError)
            .once("error", onEndOrCancelledOrError);
    }
}
