/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

import {
    CallEvent,
    ChannelEvent,
    CoatyObject,
    ReturnEvent,
} from "@coaty/core";
import { Observable } from "rxjs";
import { map, takeUntil } from "rxjs/operators";

import {
    CallEvent as PbCallEvent,
    CallSelector as PbCallSelector,
    ChannelEvent as PbChannelEvent,
    ChannelSelector as PbChannelSelector,
    ReturnEvent as PbReturnEvent,
} from "../service/tn-communication-service";
import { TnBaseController } from "./tn-base-controller";

/**
 * Transforms gRPC client calls onto Coaty communication events and vice versa.
 */
export class TnCommunicationController extends TnBaseController {

    /**
     * Marshal the given PbChannel event and publish it as a Coaty Channel
     * event on the given channel identifier.
     *
     * @param event a PbChannelEvent that is converted to a Coaty object for
     * publication on the given channel identifier
     * @throws if given channel identifier is not in a valid format
     */
    publishChannel(event: PbChannelEvent) {
        const { id, data, sourceId } = event;
        const coatyObject = {
            name: "Auto-created from Protobuf Any",
            objectId: this.runtime.newUuid(),
            coreType: "CoatyObject",
            objectType: data.type_url,
            value: this.byteArrayToBase64(data.value),
            sourceId,
        } as CoatyObject;
        this.communicationManager.publishChannel(ChannelEvent.withObject(id, coatyObject));
    }

    /**
     * Observe PbChannelEvents for the given channel selector.
     *
     * @param selector a channel selector
     * @param onCancelled$ an observable on which a value is emitted if the
     * associated gRPC call is cancelled
     * @returns an observable emitting PbChannelEvents for the given publication
     * @throws if given channel selector's identifier is not in a valid format
     */
    observeChannel(selector: PbChannelSelector, onCancelled$: Observable<unknown>): Observable<PbChannelEvent> {
        return this.communicationManager.observeChannel(selector.id)
            .pipe(
                takeUntil(onCancelled$),
                map(evt => {
                    const pbChannelEvt: PbChannelEvent = {
                        id: evt.channelId,
                        data: {
                            type_url: evt.data.object.objectType,
                            value: this.base64ToByteArray(evt.data.object["value"]),
                        },
                    };
                    const sourceId = evt.data.object["sourceId"];
                    if (sourceId !== undefined) {
                        pbChannelEvt.sourceId = sourceId;
                    }
                    return pbChannelEvt;
                }),
            );
    }

    /**
     * Marshal the given PbCallEvent and publish it as a Coaty Call event with
     * the given call operation.
     *
     * @param event a PbChannelEvent
     * @param onCancelled$ an observable on which a value is emitted if the
     * associated gRPC call is cancelled
     * @returns an observable emitting PbReturnEvents for the given publication
     * @throws if given call operation is not in a valid format
     */
    publishCall(event: PbCallEvent, onCancelled$: Observable<unknown>) {
        const paramaters = {
            type_url: event.parameters.type_url,
            value: this.byteArrayToBase64(event.parameters.value),
            sourceId: event.sourceId,
        };
        return this.communicationManager.publishCall(CallEvent.with(event.operation, paramaters))
            .pipe(
                takeUntil(onCancelled$),
                map(returnEvent => returnEvent.data),
                map(data => {
                    const evt: PbReturnEvent = {};
                    if (data.executionInfo.sourceId !== undefined) {
                        evt.sourceId = data.executionInfo.sourceId;
                    }
                    if (data.isError) {
                        evt.error = data.error;
                    } else {
                        evt.data = {
                            type_url: data.result.type_url,
                            value: this.base64ToByteArray(data.result["value"]),
                        };
                    }
                    if ("type_url" in data.executionInfo && "value" in data.executionInfo) {
                        evt.executionInfo = {
                            type_url: data.executionInfo.type_url,
                            value: this.base64ToByteArray(data.executionInfo["value"]),
                        };
                    }
                    return evt;
                }),
            );
    }

    /**
     * Observe PbCallEvents for the given call selector.
     *
     * @param selector a call selector
     * @param onCancelled$ an observable on which a value is emitted if the
     * associated gRPC call is cancelled
     * @returns an observable emitting PbCallEvents for the given publication
     * @throws if given call selector's operation name is not in a valid format
     */
    observeCall(selector: PbCallSelector, onCancelled$: Observable<unknown>): Observable<PbCallEvent> {
        return this.communicationManager.observeCall(selector.operation)
            .pipe(
                takeUntil(onCancelled$),
                map(evt => {
                    // Create separate correlations per request and observer rpc so that
                    // CompleteEvents can be handled for each of them independently.
                    const correlationId = this.runtime.newUuid();
                    const sourceId = evt.data.getParameterByName("sourceId");
                    return {
                        operation: evt.operation,
                        parameters: {
                            type_url: evt.data.getParameterByName("type_url"),
                            value: this.base64ToByteArray(evt.data.getParameterByName("value")),
                        },
                        sourceId,
                        correlationId,
                        responseCallback: pbReturnEvent => {
                            const execInfo = {
                                correlationId,
                            } as any;
                            if (pbReturnEvent.sourceId !== undefined) {
                                execInfo.sourceId = pbReturnEvent.sourceId;
                            }
                            if (!!pbReturnEvent.executionInfo) {
                                execInfo.type_url = pbReturnEvent.executionInfo.type_url;
                                execInfo.value = this.byteArrayToBase64(pbReturnEvent.executionInfo.value);
                            }
                            if (pbReturnEvent.error !== undefined) {
                                evt.returnEvent(ReturnEvent.withError(pbReturnEvent.error.code, pbReturnEvent.error.message, execInfo));
                            } else {
                                evt.returnEvent(ReturnEvent.withResult({
                                    type_url: pbReturnEvent.data.type_url,
                                    value: this.byteArrayToBase64(pbReturnEvent.data.value),
                                }, execInfo));
                            }
                        },
                    };
                }),
            );
    }
}
