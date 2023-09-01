/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

import { CoatyObject, ObjectLifecycleController } from "@coaty/core";
import { Observable } from "rxjs";
import { mergeMap, takeUntil } from "rxjs/operators";
import { TnConnector } from "../common/tn-connector";

import {
    AgentLifecycleEvent,
    AgentLifecycleState,
    AgentSelector,
} from "../service/tn-lifecycle-service";
import { TnBaseController } from "./tn-base-controller";

/**
 * Transforms gRPC client calls onto Coaty lifecycle events and vice versa.
 */
export class TnLifecycleController extends TnBaseController {

    get lifecycleController() {
        return this.container.getController<ObjectLifecycleController>("ObjectLifecycleController");
    }

    /**
     * Track AgentLifecycleEvents for the given agent selector.
     *
     * @param selector a TNC agent selector
     * @param onCancelled$ an observable on which a value is emitted if the
     * associated gRPC call is cancelled
     * @returns an observable emitting AgentLifecycleEvents for the given publication
     */
    trackAgents(selector: AgentSelector, onCancelled$: Observable<unknown>) {
        const obj2Event = (obj: CoatyObject, state: AgentLifecycleState) => ({
            identity: { name: obj.name, id: obj.objectId, local: this.container.identity.objectId === obj.objectId },
            state,
        } as AgentLifecycleEvent);
        const checkName = (objName: string, selName: string | RegExp) => {
            if (selName instanceof RegExp) {
                return selName.test(objName);
            } else {
                return objName === selName;
            }
        };
        // Fail fast if selector contains an invalid Regexp.
        const selectorName = selector.identityName as string;
        if (selectorName?.startsWith("/") && selectorName.endsWith("/")) {
            try {
                selector.identityName = new RegExp(selectorName.substring(1, selectorName.length - 1));
            } catch (error) {
                throw new Error(`'${selectorName}' is not a valid JavaScript regular expression: ${error.message}`);
            }
        }
        return this.lifecycleController.observeObjectLifecycleInfoByCoreType("Identity",
            obj => obj["role"] === TnConnector.IDENTITY_ROLE &&
                (selector.identityId ?
                    obj.objectId === selector.identityId :
                    (selector.identityName ?
                        checkName(obj.name, selector.identityName) :
                        true)))
            .pipe(
                takeUntil(onCancelled$),
                mergeMap(info => {
                    const events: AgentLifecycleEvent[] = [];
                    (info.added ?? []).forEach(obj => events.push(obj2Event(obj, AgentLifecycleState.Join)));
                    (info.removed ?? []).forEach(obj => events.push(obj2Event(obj, AgentLifecycleState.Leave)));
                    // As TNC Coaty agent identity properties cannot be changed
                    // from the outside, update events should never be emitted.
                    (info.changed ?? []).forEach(obj => events.push(obj2Event(obj, AgentLifecycleState.Join)));
                    return events;
                }),
            );
    }
}
