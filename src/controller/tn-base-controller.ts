/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

import {
    Container,
    Controller,
    ControllerOptions,
} from "@coaty/core";
import Debug from "debug";

/**
 * Base Coaty controller class for handling gRPC calls.
 *
 * Protobuf Any messages received by a TN Coaty Service are converted to Coaty
 * objects: the Any.value field is encoded as a base64 string in the "value"
 * property of the corresponding Coaty object. The "objectType" property of the
 * Coaty object is set to the "type_url" field of the Any message.
 */
export class TnBaseController extends Controller {

    /**
     * Gets a debugger function associated with this controller.
     *
     * Used to log informational, debug, and error messages. The first argument
     * is a formatter string with printf-style formatting supporting the
     * following directives: `%O` (object multi-line), `%o` (object
     * single-line), `%s` (string), `%d` (number), `%j` (JSON), `%%` (escape).
     */
    public readonly debug: Debug.Debugger;

    /**
     * For internal use only.
     */
    constructor(container: Container, options: ControllerOptions, controllerName: string) {
        super(container, options, controllerName);
        this.debug = this.runtime.commonOptions.extra.debug.extend(controllerName);
    }

    base64ToByteArray(value: string) {
        return Buffer.from(value, "base64");
    }

    byteArrayToBase64(value: Uint8Array) {
        return (value instanceof Buffer ? value as Buffer : Buffer.from(value)).toString("base64");
    }

    /**
     * Overwrite to perform async side effects when the associated gRPC service
     * is about to be stopped.
     *
     * The base method does nothing and returns a resolved promise immediately.
     *
     * @returns promise that is resolved after async side effects have been
     * performed.
     */
    async onServiceStopping(): Promise<void> {
        return Promise.resolve();
    }
}
